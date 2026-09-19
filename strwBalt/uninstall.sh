#!/usr/bin/env bash
# Removes strwBalt containers and images. Your downloads are untouched.
set -e
cd "$(dirname "$0")"
echo "Stopping and removing strwBalt containers..."
docker compose down --rmi local --volumes
echo "Done. Remove the extension separately at chrome://extensions"
