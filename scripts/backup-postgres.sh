#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL es obligatoria}"
: "${BACKUP_DIR:=./backups}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/clockai-$stamp.dump"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$file"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$file" > "$file.sha256"
else
  shasum -a 256 "$file" > "$file.sha256"
fi
printf 'backup=%s\nsha256=%s\n' "$file" "$file.sha256"
