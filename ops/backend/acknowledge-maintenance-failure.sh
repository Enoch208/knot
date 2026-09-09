#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 4 ] || [ "$4" != "--confirm-clear" ]; then
  printf '%s\n' "usage: $0 ABSOLUTE_LOCK_DIRECTORY FAILURE_ID ABSOLUTE_OPERATION_TARGET --confirm-clear" >&2
  exit 64
fi

case "$1" in /*) ;; *) printf '%s\n' "lock directory must be absolute" >&2; exit 64 ;; esac
case "$3" in /*) ;; *) printf '%s\n' "operation target must be absolute" >&2; exit 64 ;; esac
case "$2" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9]*) ;; *) printf '%s\n' "failure identifier is invalid" >&2; exit 64 ;; esac

lock_directory=$1
failure_record="$lock_directory/FAILED"
if [ ! -d "$failure_record" ] && [ -d "$lock_directory/ACKNOWLEDGING" ]; then failure_record="$lock_directory/ACKNOWLEDGING"; fi
[ -d "$lock_directory" ] && [ -d "$failure_record" ] && [ -f "$lock_directory/owner" ] || {
  printf '%s\n' "failed maintenance interlock is unavailable" >&2
  exit 66
}

for name in id operation target phase failed-at-utc; do
  [ -f "$failure_record/$name" ] && [ ! -L "$failure_record/$name" ] || {
    printf '%s\n' "failed maintenance interlock is malformed" >&2
    exit 65
  }
done

[ "$(cat "$failure_record/id")" = "$2" ] || { printf '%s\n' "failure identifier does not match" >&2; exit 65; }
[ "$(cat "$failure_record/target")" = "$3" ] || { printf '%s\n' "operation target does not match" >&2; exit 65; }
case "$(cat "$failure_record/operation")" in backup|restore) ;; *) printf '%s\n' "failed maintenance operation is invalid" >&2; exit 65 ;; esac
case "$(cat "$failure_record/phase")" in writer-restart|writer-health|rollback-writer-quiesce|automatic-rollback|rollback-readback) ;; *) printf '%s\n' "failed maintenance phase is invalid" >&2; exit 65 ;; esac

if [ "$failure_record" = "$lock_directory/FAILED" ]; then
  mv "$failure_record" "$lock_directory/ACKNOWLEDGING"
  failure_record="$lock_directory/ACKNOWLEDGING"
fi
rm "$failure_record/id" "$failure_record/operation" "$failure_record/target" "$failure_record/phase" "$failure_record/failed-at-utc"
rmdir "$failure_record"
rm "$lock_directory/owner"
rmdir "$lock_directory"
printf '%s\n' "acknowledged maintenance failure $2 for $3"
