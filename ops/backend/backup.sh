#!/bin/sh
set -eu

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
snapshot="$1/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$snapshot/artifacts"

dc() {
  docker compose --project-directory "$repository_directory" --file "$script_directory/compose.yaml" "$@"
}

dc exec -T postgres sh -ceu 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$snapshot/database.dump"
dc run --rm --no-deps --volume "$snapshot:/backup" artifact-tools 'mc alias set local http://object-store:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror --overwrite local/knot-artifacts /backup/artifacts'
cp "$script_directory/compose.yaml" "$snapshot/compose.yaml"
cp "$repository_directory/ops/manifests/network-56.json" "$snapshot/network-56.json"
cp "$repository_directory/ops/manifests/network-97.json" "$snapshot/network-97.json"
(cd "$snapshot" && sha256sum database.dump compose.yaml network-56.json network-97.json > SHA256SUMS && find artifacts -type f -print0 | sort -z | xargs -0 -r sha256sum >> SHA256SUMS)
printf '%s\n' "$snapshot"

