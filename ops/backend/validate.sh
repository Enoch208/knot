#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_directory=$(CDPATH= cd -- "$script_directory/../.." && pwd)
node "$script_directory/validate-secrets.mjs"
docker compose --project-directory "$repository_directory" --file "$script_directory/compose.yaml" config --quiet
