#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  printf '%s\n' "usage: $0 ABSOLUTE_BACKUP_DIRECTORY" >&2
  exit 64
fi

case "$1" in
  /*) ;;
  *) printf '%s\n' "backup directory must be absolute" >&2; exit 64 ;;
esac

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_directory=$(CDPATH= cd -- "$script_directory/../.." && pwd)
. "$script_directory/snapshot-common.sh"

mkdir -p "$1"
backup_root=$(CDPATH= cd -- "$1" && pwd)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
final_snapshot="$backup_root/$timestamp"
staging_snapshot="$backup_root/.$timestamp.$$.incomplete"
snapshot_lock="$backup_root/.$timestamp.lock"

writers_stopped=0
completed=0
lock_acquired=0
maintenance_lock_owned=0
maintenance_lock_failed=0
maintenance_operation=backup
maintenance_target=$final_snapshot

finish() {
  result=$?
  trap - EXIT HUP INT TERM
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
  if [ "$completed" -ne 1 ]; then
    rm -rf -- "$staging_snapshot"
  fi
  if [ "$lock_acquired" -eq 1 ]; then
    if ! rmdir "$snapshot_lock"; then
      printf '%s\n' "snapshot lock cleanup failed" >&2
      result=1
    fi
  fi
  if ! release_maintenance_lock; then
    printf '%s\n' "maintenance lock cleanup failed" >&2
    result=1
  fi
  if [ "$result" -eq 0 ] && [ "$completed" -eq 1 ]; then
    printf '%s\n' "$final_snapshot"
  fi
  exit "$result"
}

trap finish EXIT HUP INT TERM
acquire_maintenance_lock "backup-$$"
if ! mkdir "$snapshot_lock"; then
  printf '%s\n' "snapshot destination is already locked" >&2
  exit 73
fi
lock_acquired=1
[ ! -e "$final_snapshot" ] && [ ! -e "$staging_snapshot" ] || {
  printf '%s\n' "snapshot destination already exists" >&2
  exit 73
}
mkdir "$staging_snapshot"
mkdir "$staging_snapshot/buckets"
mkdir "$staging_snapshot/buckets/knot-artifacts"
mkdir "$staging_snapshot/buckets/knot-deliverables"
writer_container_metadata "$staging_snapshot/deployed-images.tsv"

if [ "${KNOT_BACKUP_QUIESCED_BY_RESTORE:-0}" != "1" ]; then
  writers_stopped=1
  stop_writers
else
  assert_writers_stopped
fi

primary_database=$(dc exec -T postgres sh -ceu 'printf "%s" "$POSTGRES_DB"')
assert_no_active_work "$primary_database"
printf '%s\n' "0" > "$staging_snapshot/active-work-count.txt"
dc exec -T postgres sh -ceu 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$staging_snapshot/database.dump"
mirror_bucket_to_directory knot-artifacts "$staging_snapshot/buckets/knot-artifacts"
mirror_bucket_to_directory knot-deliverables "$staging_snapshot/buckets/knot-deliverables"
write_database_counts "$primary_database" "$staging_snapshot/database-counts.tsv"
node "$script_directory/snapshot-manifest.mjs" capture "$staging_snapshot" "$repository_directory" "$staging_snapshot/deployed-images.tsv" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
manifest_hash=$(sha256sum "$staging_snapshot/manifest.json" | awk '{print $1}')
printf '%s\n' "$manifest_hash" > "$staging_snapshot/.COMPLETE.tmp"
mv "$staging_snapshot/.COMPLETE.tmp" "$staging_snapshot/COMPLETE"
node "$script_directory/snapshot-manifest.mjs" validate "$staging_snapshot"
mv "$staging_snapshot" "$final_snapshot"
completed=1
