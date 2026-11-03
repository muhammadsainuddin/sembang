#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
backup_dir="${BACKUP_DIR:-/var/backups/sembang}"
install -d -m 0700 "$backup_dir"
exec 9>"$backup_dir/.backup.lock"
flock -n 9 || { echo 'Backup lain masih berjalan.' >&2; exit 1; }
compose_file="${COMPOSE_FILE:-compose.yaml}"
[[ -f deploy/compose-mode ]] && compose_file="$(<deploy/compose-mode)"
[[ "$compose_file" == compose.yaml || "$compose_file" == compose.external-proxy.yaml ]] || { echo 'Mod Compose tidak sah.' >&2; exit 1; }
docker compose -f "$compose_file" run --rm --no-deps --user 0:0 --cap-add DAC_OVERRIDE --volume "$backup_dir:/backups:Z" \
  --env BACKUP_DIR=/backups --env BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}" \
  --entrypoint node sembang scripts/backup.mjs
