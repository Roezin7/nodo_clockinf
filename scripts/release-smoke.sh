#!/usr/bin/env bash
set -euo pipefail

# Uso: scripts/release-smoke.sh https://clockai.example.com
# Sólo comprueba que la aplicación publicada está lista; no modifica datos.
base_url="${1:?Uso: scripts/release-smoke.sh https://host}"
base_url="${base_url%/}"
headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$headers" "$body"' EXIT

curl --fail --silent --show-error --location \
  --dump-header "$headers" --output "$body" \
  "$base_url/api/health"

node -e '
  const fs = require("node:fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (result.ok !== true) process.exit(1);
' "$body"

for header in 'content-security-policy:' 'x-content-type-options: nosniff' 'x-request-id:' 'cache-control: no-store'; do
  if ! rg -i -q "^${header}" "$headers"; then
    echo "Falta encabezado esperado: $header" >&2
    exit 1
  fi
done

curl --fail --silent --show-error --location "$base_url/api/health/live" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    if (result.ok !== true) process.exit(1);
  });
'

echo "Release smoke PASS: $base_url"
