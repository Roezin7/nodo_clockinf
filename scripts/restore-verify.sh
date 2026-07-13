#!/usr/bin/env bash
set -euo pipefail

: "${RESTORE_VERIFY_DATABASE_URL:?RESTORE_VERIFY_DATABASE_URL es obligatoria}"
: "${ALLOW_RESTORE_VERIFY:?Define ALLOW_RESTORE_VERIFY=yes para continuar}"

if [[ "$ALLOW_RESTORE_VERIFY" != "yes" ]]; then
  echo "La restauración requiere ALLOW_RESTORE_VERIFY=yes" >&2
  exit 2
fi
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Uso: RESTORE_VERIFY_DATABASE_URL=... ALLOW_RESTORE_VERIFY=yes $0 backup.dump" >&2
  exit 2
fi

backup="$1"
if [[ -f "$backup.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$backup")" && sha256sum -c "$(basename "$backup").sha256")
  else
    expected="$(awk '{print $1}' "$backup.sha256")"
    actual="$(shasum -a 256 "$backup" | awk '{print $1}')"
    [[ "$expected" == "$actual" ]] || { echo "Checksum inválido" >&2; exit 1; }
  fi
fi
pg_restore --dbname="$RESTORE_VERIFY_DATABASE_URL" --clean --if-exists --no-owner --no-privileges "$backup"
psql "$RESTORE_VERIFY_DATABASE_URL" --set=ON_ERROR_STOP=1 --tuples-only --command \
  "SELECT 'migrations=' || count(*) FROM pgmigrations; SELECT 'organizations=' || count(*) FROM organizations;"
echo "restore verification completed"
