#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/5] JavaScript syntax"
while IFS= read -r file; do node --check "$file"; done < <(rg --files -g '*.js')

echo "[2/5] JSON manifests"
node -e 'const fs=require("fs"),cp=require("child_process"); for(const f of cp.execFileSync("rg",["--files","-g","*.json"],{encoding:"utf8"}).trim().split(/\r?\n/).filter(Boolean)) JSON.parse(fs.readFileSync(f,"utf8"));'

echo "[3/5] Compose configuration and localhost bindings"
cd strwBalt
docker compose config --quiet
config="$(docker compose config)"
count="$(grep -Fc 'host_ip: 127.0.0.1' <<<"$config")"
[[ "$count" -ge 3 ]] || { echo "all three published ports must bind to 127.0.0.1" >&2; exit 1; }

echo "[4/5] yt-dlp API unit tests"
docker compose build ytdlp-api
docker compose run --rm --no-deps --entrypoint python ytdlp-api -m unittest -v test_server.py

echo "[5/5] SpotDL API unit tests"
docker compose build spotdl-api
docker compose run --rm --no-deps --entrypoint python spotdl-api -m unittest -v test_server.py

echo "All automated checks passed."
echo "Complete MANUAL_TESTS.md for browser-only behavior."
