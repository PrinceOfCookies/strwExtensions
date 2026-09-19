#!/usr/bin/env bash
# strwBalt installer — macOS / Linux
set -e

cd "$(dirname "$0")"

if [ ! -f .env ]; then
    token="$(openssl rand -hex 24)"
    printf 'STRWBALT_API_KEY=%s\n' "$token" > .env
    chmod 600 .env
fi

echo ""
echo "  strwBalt setup"
echo "  =============="
echo ""

if ! command -v docker >/dev/null 2>&1; then
    echo "  Docker isn't installed."
    echo "  Get Docker Desktop: https://www.docker.com/products/docker-desktop/"
    echo "  Install it, open it once, then run this script again."
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "  Docker is installed but not running."
    echo "  Open Docker Desktop, wait for it to say 'running', then re-run this."
    exit 1
fi

echo "  Building and starting containers (first run takes a few minutes)..."
echo ""
docker compose up -d --build

echo ""
echo "  Waiting for backends..."

wait_for () {
    name="$1"; url="$2"
    i=0
    while [ $i -lt 60 ]; do
        if curl -fsS "$url" >/dev/null 2>&1; then
            echo "    $name: ready"
            return 0
        fi
        i=$((i+1)); sleep 2
    done
    echo "    $name: NOT responding — check 'docker compose logs $3'"
    return 1
}

ok=0
wait_for "cobalt " "http://localhost:9000/"       cobalt    || ok=1
wait_for "yt-dlp " "http://localhost:9100/health" ytdlp-api || ok=1

echo ""
if [ $ok -eq 0 ]; then
    echo "  Backend is running."
else
    echo "  Backend started with problems — see the messages above."
fi

echo "  API key (paste this into the extension Options page):"
sed 's/^STRWBALT_API_KEY=/  /' .env

cat <<'NEXT'

  Next: install the browser extension
  -----------------------------------
  1. Open Chrome and go to:   chrome://extensions
  2. Turn on "Developer mode" (top right)
  3. Click "Load unpacked"
  4. Select the "extension" folder inside this one

  Then click the strwBalt icon in your toolbar. Both status dots
  should be green.

  Useful commands (run from this folder):
    docker compose logs -f     watch the logs
    docker compose down        stop everything
    docker compose up -d       start again
    docker compose restart ytdlp-api   fix most youtube breakage

NEXT
