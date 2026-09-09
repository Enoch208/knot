#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 2 ] || [ "$2" != "--confirm-replace" ]; then
  printf '%s\n' "usage: $0 ABSOLUTE_SNAPSHOT_DIRECTORY --confirm-replace" >&2
  exit 64
fi

case "$1" in
  /*) ;;
  *) printf '%s\n' "snapshot directory must be absolute" >&2; exit 64 ;;
esac

snapshot=$(CDPATH= cd -- "$1" && pwd)
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_directory=$(CDPATH= cd -- "$script_directory/../.." && pwd)
. "$script_directory/snapshot-common.sh"

shadow_database="knot_restore_shadow_$$"
shadow_artifacts_bucket="knot-restore-artifacts-$$"
shadow_deliverables_bucket="knot-restore-deliverables-$$"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/knot-restore.XXXXXX")
rollback_root=${KNOT_ROLLBACK_DIRECTORY:-"$(dirname -- "$snapshot")/.rollback"}
case "$rollback_root" in
  /*) ;;
  *) printf '%s\n' "rollback directory must be absolute" >&2; rm -rf -- "$temporary_root"; exit 64 ;;
esac

writers_stopped=0
cutover_started=0
shadow_database_created=0
shadow_artifacts_created=0
shadow_deliverables_created=0
maintenance_lock_owned=0
maintenance_lock_failed=0
maintenance_operation=restore
maintenance_target=$snapshot
rollback_snapshot=
success=0

cleanup_shadow() {
  cleanup_result=0
  if [ "$shadow_database_created" -eq 1 ]; then
    if dc exec -T --env "KNOT_DATABASE_NAME=$shadow_database" postgres sh -ceu 'dropdb --username="$POSTGRES_USER" --if-exists --force "$KNOT_DATABASE_NAME"'; then shadow_database_created=0; else cleanup_result=1; fi
  fi
  if [ "$shadow_artifacts_created" -eq 1 ]; then
    if remove_bucket "$shadow_artifacts_bucket"; then shadow_artifacts_created=0; else cleanup_result=1; fi
  fi
  if [ "$shadow_deliverables_created" -eq 1 ]; then
    if remove_bucket "$shadow_deliverables_bucket"; then shadow_deliverables_created=0; else cleanup_result=1; fi
  fi
  return "$cleanup_result"
}

verify_restored_state() {
  source_snapshot=$1
  database_name=$2
  label=$3
  write_database_counts "$database_name" "$temporary_root/$label-counts.tsv"
  node "$script_directory/snapshot-manifest.mjs" compare-counts "$source_snapshot" "$temporary_root/$label-counts.tsv"
  assert_no_active_work "$database_name"
  mirror_bucket_to_directory knot-artifacts "$temporary_root/$label-knot-artifacts"
  node "$script_directory/snapshot-manifest.mjs" compare-artifacts "$source_snapshot" knot-artifacts "$temporary_root/$label-knot-artifacts"
  mirror_bucket_to_directory knot-deliverables "$temporary_root/$label-knot-deliverables"
  node "$script_directory/snapshot-manifest.mjs" compare-artifacts "$source_snapshot" knot-deliverables "$temporary_root/$label-knot-deliverables"
}

finish() {
  result=$?
  trap - EXIT HUP INT TERM
  if ! cleanup_shadow; then printf '%s\n' "shadow resource cleanup failed" >&2; result=1; fi
  if [ "$success" -ne 1 ] && [ "$cutover_started" -eq 1 ] && [ -n "$rollback_snapshot" ]; then
    printf '%s\n' "restore failed; applying private rollback snapshot" >&2
    writers_stopped=1
    if ! stop_writers; then
      mark_maintenance_failed rollback-writer-quiesce || true
      printf '%s\n' "automatic rollback could not quiesce every writer" >&2
      rm -rf -- "$temporary_root"
      release_maintenance_lock || true
      exit 1
    fi
    rollback_database=$(dc exec -T postgres sh -ceu 'printf "%s" "$POSTGRES_DB"')
    if ! restore_database "$rollback_database" "$rollback_snapshot/database.dump" || ! mirror_snapshot_to_bucket "$rollback_snapshot" knot-artifacts knot-artifacts || ! mirror_snapshot_to_bucket "$rollback_snapshot" knot-deliverables knot-deliverables; then
      mark_maintenance_failed automatic-rollback || true
      printf '%s\n' "automatic rollback failed; writers remain stopped" >&2
      rm -rf -- "$temporary_root"
      release_maintenance_lock || true
      exit 1
    fi
    if ! verify_restored_state "$rollback_snapshot" "$rollback_database" rollback; then
      mark_maintenance_failed rollback-readback || true
      printf '%s\n' "automatic rollback readback failed; writers remain stopped" >&2
      rm -rf -- "$temporary_root"
      release_maintenance_lock || true
      exit 1
    fi
  fi
  if [ "$writers_stopped" -eq 1 ]; then
    if ! start_writers; then
      mark_maintenance_failed writer-restart || true
      printf '%s\n' "writer restart failed" >&2
      result=1
    elif ! wait_for_writers; then
      mark_maintenance_failed writer-health || true
      printf '%s\n' "writer health check failed" >&2
      result=1
    fi
  fi
  rm -rf -- "$temporary_root"
  if ! release_maintenance_lock; then printf '%s\n' "maintenance lock cleanup failed" >&2; result=1; fi
  if [ "$result" -eq 0 ] && [ "$success" -eq 1 ]; then printf '%s\n' "restore complete; rollback snapshot retained at $rollback_snapshot"; fi
  exit "$result"
}

trap finish EXIT HUP INT TERM
acquire_maintenance_lock "restore-$$"
node "$script_directory/snapshot-manifest.mjs" validate "$snapshot"
writer_container_metadata "$temporary_root/deployed-images.tsv"
node "$script_directory/snapshot-manifest.mjs" compatible "$snapshot" "$repository_directory" "$temporary_root/deployed-images.tsv"

shadow_database_created=1
restore_database "$shadow_database" "$snapshot/database.dump"
write_database_counts "$shadow_database" "$temporary_root/shadow-counts.tsv"
node "$script_directory/snapshot-manifest.mjs" compare-counts "$snapshot" "$temporary_root/shadow-counts.tsv"
assert_no_active_work "$shadow_database"

shadow_artifacts_created=1
mirror_snapshot_to_bucket "$snapshot" knot-artifacts "$shadow_artifacts_bucket"
mirror_bucket_to_directory "$shadow_artifacts_bucket" "$temporary_root/shadow-knot-artifacts"
node "$script_directory/snapshot-manifest.mjs" compare-artifacts "$snapshot" knot-artifacts "$temporary_root/shadow-knot-artifacts"
shadow_deliverables_created=1
mirror_snapshot_to_bucket "$snapshot" knot-deliverables "$shadow_deliverables_bucket"
mirror_bucket_to_directory "$shadow_deliverables_bucket" "$temporary_root/shadow-knot-deliverables"
node "$script_directory/snapshot-manifest.mjs" compare-artifacts "$snapshot" knot-deliverables "$temporary_root/shadow-knot-deliverables"
cleanup_shadow

writers_stopped=1
stop_writers
primary_database=$(dc exec -T postgres sh -ceu 'printf "%s" "$POSTGRES_DB"')
assert_no_active_work "$primary_database"
mkdir -p "$rollback_root"
rollback_snapshot=$(KNOT_BACKUP_QUIESCED_BY_RESTORE=1 KNOT_MAINTENANCE_LOCK_DIRECTORY="$maintenance_lock_path" KNOT_MAINTENANCE_LOCK_OWNER="$maintenance_lock_owner" "$script_directory/backup.sh" "$rollback_root")
rollback_snapshot=$(printf '%s\n' "$rollback_snapshot" | tail -n 1)
case "$rollback_snapshot" in "$rollback_root"/*) ;; *) printf '%s\n' "rollback snapshot path is invalid" >&2; exit 1 ;; esac
node "$script_directory/snapshot-manifest.mjs" validate "$rollback_snapshot"

cutover_started=1
restore_database "$primary_database" "$snapshot/database.dump"
mirror_snapshot_to_bucket "$snapshot" knot-artifacts knot-artifacts
mirror_snapshot_to_bucket "$snapshot" knot-deliverables knot-deliverables
verify_restored_state "$snapshot" "$primary_database" cutover

if ! start_writers; then mark_maintenance_failed writer-restart; exit 1; fi
if ! wait_for_writers; then mark_maintenance_failed writer-health; exit 1; fi
writers_stopped=0
success=1
