#!/bin/sh
set -eu

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
(cd "$snapshot" && sha256sum --check SHA256SUMS)

dc() {
  docker compose --project-directory "$repository_directory" --file "$script_directory/compose.yaml" "$@"
}

dc stop api worker
dc exec -T postgres sh -ceu 'dropdb --username="$POSTGRES_USER" --force "$POSTGRES_DB"; createdb --username="$POSTGRES_USER" --owner="$POSTGRES_USER" "$POSTGRES_DB"'
dc exec -T postgres sh -ceu 'pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-owner --no-acl --exit-on-error' < "$snapshot/database.dump"
dc run --rm --no-deps --volume "$snapshot:/backup:ro" artifact-tools 'mc alias set local http://object-store:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror --overwrite --remove /backup/artifacts local/knot-artifacts'
dc start api worker

