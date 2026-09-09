#!/bin/sh

dc() {
  docker compose --project-directory "$repository_directory" --file "$script_directory/compose.yaml" "$@"
}

seller_dc() {
  seller_name=$1
  shift
  docker compose --project-directory "$repository_directory/agents/$seller_name" --file "$repository_directory/agents/$seller_name/ops/vps/compose.yaml" "$@"
}

acquire_maintenance_lock() {
  maintenance_lock_path=${KNOT_MAINTENANCE_LOCK_DIRECTORY:-/var/lock/knot-backend-maintenance.lock}
  case "$maintenance_lock_path" in
    /*) ;;
    *) printf '%s\n' "maintenance lock path must be absolute" >&2; return 1 ;;
  esac
  inherited_owner=${KNOT_MAINTENANCE_LOCK_OWNER:-}
  if [ -n "$inherited_owner" ]; then
    [ ! -e "$maintenance_lock_path/FAILED" ] && [ -d "$maintenance_lock_path" ] && [ -f "$maintenance_lock_path/owner" ] && [ "$(cat "$maintenance_lock_path/owner")" = "$inherited_owner" ] || {
      printf '%s\n' "inherited maintenance lock is invalid" >&2
      return 1
    }
    maintenance_lock_owned=0
    maintenance_lock_owner=$inherited_owner
    return 0
  fi
  if ! mkdir "$maintenance_lock_path"; then
    if [ -d "$maintenance_lock_path/FAILED" ]; then
      printf '%s\n' "a failed maintenance interlock requires explicit acknowledgement" >&2
    else
      printf '%s\n' "another backup or restore holds the maintenance lock" >&2
    fi
    return 1
  fi
  maintenance_lock_owned=1
  maintenance_lock_owner=$1
  printf '%s\n' "$maintenance_lock_owner" > "$maintenance_lock_path/owner"
}

release_maintenance_lock() {
  if [ "${maintenance_lock_owned:-0}" -eq 1 ] && [ "${maintenance_lock_failed:-0}" -ne 1 ]; then
    rm -f -- "$maintenance_lock_path/owner"
    rmdir "$maintenance_lock_path"
    maintenance_lock_owned=0
  fi
}

mark_maintenance_failed() {
  failure_phase=$1
  maintenance_lock_failed=1
  [ "${maintenance_lock_owned:-0}" -eq 1 ] || return 1
  if [ -d "$maintenance_lock_path/FAILED" ]; then return 0; fi
  failure_staging="$maintenance_lock_path/.FAILED.$$"
  mkdir "$failure_staging"
  failure_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  printf '%s\n' "$failure_id" > "$failure_staging/id"
  printf '%s\n' "$maintenance_operation" > "$failure_staging/operation"
  printf '%s\n' "$maintenance_target" > "$failure_staging/target"
  printf '%s\n' "$failure_phase" > "$failure_staging/phase"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$failure_staging/failed-at-utc"
  mv "$failure_staging" "$maintenance_lock_path/FAILED"
  printf '%s\n' "maintenance failure interlock $failure_id retained at $maintenance_lock_path" >&2
}

validate_image_metadata() {
  image_name=$1
  image_reference=$2
  image_id=$3
  case "$image_reference" in
    *@sha256:????????????????????????????????????????????????????????????????) ;;
    *) printf '%s\n' "$image_name image reference must be pinned by sha256 digest" >&2; return 1 ;;
  esac
  case "$image_id" in
    sha256:????????????????????????????????????????????????????????????????) ;;
    *) printf '%s\n' "$image_name image id must be a sha256 digest" >&2; return 1 ;;
  esac
}

writer_container_metadata() {
  output_path=$1
  api_container=$(dc ps --all -q api)
  worker_container=$(dc ps --all -q worker)
  [ -n "$api_container" ] && [ -n "$worker_container" ] || {
    printf '%s\n' "api and worker containers must exist" >&2
    return 1
  }
  api_reference=$(docker inspect --format '{{.Config.Image}}' "$api_container")
  worker_reference=$(docker inspect --format '{{.Config.Image}}' "$worker_container")
  api_image_id=$(docker inspect --format '{{.Image}}' "$api_container")
  worker_image_id=$(docker inspect --format '{{.Image}}' "$worker_container")
  [ "$api_reference" = "$worker_reference" ] && [ "$api_image_id" = "$worker_image_id" ] || {
    printf '%s\n' "api and worker must run the same image" >&2
    return 1
  }
  validate_image_metadata backend "$api_reference" "$api_image_id"
  : > "$output_path"
  printf '%s\t%s\t%s\n' backend "$api_reference" "$api_image_id" >> "$output_path"
  for seller_name in healthguard rangepilot gridquant yieldscout; do
    seller_container=$(seller_dc "$seller_name" ps --all -q agent)
    [ -n "$seller_container" ] || { printf '%s\n' "$seller_name container must exist" >&2; return 1; }
    seller_reference=$(docker inspect --format '{{.Config.Image}}' "$seller_container")
    seller_image_id=$(docker inspect --format '{{.Image}}' "$seller_container")
    validate_image_metadata "$seller_name" "$seller_reference" "$seller_image_id"
    printf '%s\t%s\t%s\n' "$seller_name" "$seller_reference" "$seller_image_id" >> "$output_path"
  done
}

stop_writers() {
  writer_result=0
  dc stop api worker || writer_result=1
  for seller_name in healthguard rangepilot gridquant yieldscout; do
    seller_dc "$seller_name" stop agent || writer_result=1
  done
  return "$writer_result"
}

assert_writers_stopped() {
  api_container=$(dc ps --all -q api)
  worker_container=$(dc ps --all -q worker)
  [ -n "$api_container" ] && [ -n "$worker_container" ] || {
    printf '%s\n' "api and worker containers must exist" >&2
    return 1
  }
  api_running=$(docker inspect --format '{{.State.Running}}' "$api_container")
  worker_running=$(docker inspect --format '{{.State.Running}}' "$worker_container")
  [ "$api_running" = "false" ] && [ "$worker_running" = "false" ] || {
    printf '%s\n' "restore-owned backup requires backend writers to be stopped" >&2
    return 1
  }
  for seller_name in healthguard rangepilot gridquant yieldscout; do
    seller_container=$(seller_dc "$seller_name" ps --all -q agent)
    [ -n "$seller_container" ] && [ "$(docker inspect --format '{{.State.Running}}' "$seller_container")" = "false" ] || {
      printf '%s\n' "restore-owned backup requires every seller writer to be stopped" >&2
      return 1
    }
  done
}

start_writers() {
  writer_result=0
  dc start api worker || writer_result=1
  for seller_name in healthguard rangepilot gridquant yieldscout; do
    seller_dc "$seller_name" start agent || writer_result=1
  done
  return "$writer_result"
}

wait_for_writers() {
  attempts=${KNOT_OPS_WAIT_ATTEMPTS:-120}
  iteration=0
  while [ "$iteration" -lt "$attempts" ]; do
    api_container=$(dc ps --all -q api)
    worker_container=$(dc ps --all -q worker)
    if [ -n "$api_container" ] && [ -n "$worker_container" ]; then
      api_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$api_container")
      worker_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$worker_container")
      all_sellers_healthy=1
      for seller_name in healthguard rangepilot gridquant yieldscout; do
        seller_container=$(seller_dc "$seller_name" ps --all -q agent)
        if [ -z "$seller_container" ] || [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$seller_container")" != "healthy" ]; then
          all_sellers_healthy=0
        fi
      done
      if [ "$api_health" = "healthy" ] && [ "$worker_health" = "healthy" ] && [ "$all_sellers_healthy" -eq 1 ]; then
        dc exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
        return 0
      fi
    fi
    iteration=$((iteration + 1))
    sleep 1
  done
  printf '%s\n' "backend and seller writers did not become healthy" >&2
  return 1
}

active_work_count() {
  database_name=$1
  dc exec -T --env "KNOT_DATABASE_NAME=$database_name" postgres sh -ceu 'psql --username="$POSTGRES_USER" --dbname="$KNOT_DATABASE_NAME" --tuples-only --no-align --command="SELECT (SELECT count(*) FROM jobs WHERE work_state NOT IN ('"'"'OUTPUT_CHECKED'"'"','"'"'FAILED'"'"','"'"'EXPIRED'"'"','"'"'CANCELED'"'"') OR financial_state IN ('"'"'FUNDING_PENDING'"'"','"'"'ESCROWED'"'"','"'"'RESOLUTION_PENDING'"'"','"'"'UNKNOWN'"'"')) + (SELECT count(*) FROM chain_actions WHERE state IN ('"'"'PREPARED'"'"','"'"'SUBMITTED'"'"','"'"'UNKNOWN'"'"'));"' | tr -d '[:space:]'
}

assert_no_active_work() {
  database_name=$1
  active_count=$(active_work_count "$database_name")
  case "$active_count" in
    ''|*[!0-9]*) printf '%s\n' "active work query returned an invalid result" >&2; return 1 ;;
    0) return 0 ;;
    *) printf '%s\n' "logical snapshot refused: $active_count active jobs or chain actions require reconciliation" >&2; return 1 ;;
  esac
}

write_database_counts() {
  database_name=$1
  output_path=$2
  dc exec -T --env "KNOT_DATABASE_NAME=$database_name" postgres sh -ceu 'psql --username="$POSTGRES_USER" --dbname="$KNOT_DATABASE_NAME" --tuples-only --no-align --field-separator="	" --command="SELECT table_name, row_count FROM (SELECT '"'"'agent_capabilities'"'"' AS table_name, count(*) AS row_count FROM agent_capabilities UNION ALL SELECT '"'"'agents'"'"', count(*) FROM agents UNION ALL SELECT '"'"'artifacts'"'"', count(*) FROM artifacts UNION ALL SELECT '"'"'auditions'"'"', count(*) FROM auditions UNION ALL SELECT '"'"'benchmark_runs'"'"', count(*) FROM benchmark_runs UNION ALL SELECT '"'"'candidate_runs'"'"', count(*) FROM candidate_runs UNION ALL SELECT '"'"'chain_action_recovery_attempts'"'"', count(*) FROM chain_action_recovery_attempts UNION ALL SELECT '"'"'chain_actions'"'"', count(*) FROM chain_actions UNION ALL SELECT '"'"'claims'"'"', count(*) FROM claims UNION ALL SELECT '"'"'endpoint_observations'"'"', count(*) FROM endpoint_observations UNION ALL SELECT '"'"'erc8004_identity_observations'"'"', count(*) FROM erc8004_identity_observations UNION ALL SELECT '"'"'evaluations'"'"', count(*) FROM evaluations UNION ALL SELECT '"'"'job_events'"'"', count(*) FROM job_events UNION ALL SELECT '"'"'jobs'"'"', count(*) FROM jobs UNION ALL SELECT '"'"'outbox'"'"', count(*) FROM outbox UNION ALL SELECT '"'"'quotes'"'"', count(*) FROM quotes UNION ALL SELECT '"'"'service_requests'"'"', count(*) FROM service_requests UNION ALL SELECT '"'"'sessions'"'"', count(*) FROM sessions UNION ALL SELECT '"'"'snapshots'"'"', count(*) FROM snapshots UNION ALL SELECT '"'"'tasks'"'"', count(*) FROM tasks UNION ALL SELECT '"'"'verified_quotes'"'"', count(*) FROM verified_quotes) AS counts ORDER BY table_name;"' > "$output_path"
}

restore_database() {
  database_name=$1
  dump_path=$2
  dc exec -T --env "KNOT_DATABASE_NAME=$database_name" postgres sh -ceu 'dropdb --username="$POSTGRES_USER" --if-exists --force "$KNOT_DATABASE_NAME"; createdb --username="$POSTGRES_USER" --owner="$POSTGRES_USER" "$KNOT_DATABASE_NAME"'
  dc exec -T --env "KNOT_DATABASE_NAME=$database_name" postgres sh -ceu 'pg_restore --username="$POSTGRES_USER" --dbname="$KNOT_DATABASE_NAME" --no-owner --no-acl --exit-on-error' < "$dump_path"
}

mirror_snapshot_to_bucket() {
  snapshot_path=$1
  source_bucket=$2
  target_bucket=$3
  dc run --rm --no-deps --env "KNOT_BUCKET=$target_bucket" --env "KNOT_SOURCE_BUCKET=$source_bucket" --volume "$snapshot_path:/backup:ro" artifact-tools 'mc alias set local http://object-store:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mb --ignore-existing "local/$KNOT_BUCKET" >/dev/null; mc mirror --overwrite --remove "/backup/buckets/$KNOT_SOURCE_BUCKET" "local/$KNOT_BUCKET"'
}

mirror_bucket_to_directory() {
  bucket_name=$1
  output_path=$2
  mkdir -p "$output_path"
  dc run --rm --no-deps --env "KNOT_BUCKET=$bucket_name" --volume "$output_path:/readback" artifact-tools 'mc alias set local http://object-store:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror --overwrite --remove "local/$KNOT_BUCKET" /readback'
}

remove_bucket() {
  bucket_name=$1
  dc run --rm --no-deps --env "KNOT_BUCKET=$bucket_name" artifact-tools 'mc alias set local http://object-store:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc rb --force "local/$KNOT_BUCKET"'
}
