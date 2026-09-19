#!/bin/sh
# spotdl and yt-dlp both break when YouTube changes; keeping them current is
# most of what keeps this working. Set AUTO_UPDATE=0 to skip.
if [ "${AUTO_UPDATE:-0}" = "1" ]; then
    echo "[entrypoint] updating spotdl + yt-dlp..."
    pip install --no-cache-dir -U spotdl yt-dlp bgutil-ytdlp-pot-provider \
        || echo "[entrypoint] update failed, using bundled versions"
fi

echo "[entrypoint] spotdl version: $(spotdl --version 2>&1 | head -1)"

# gthread with a generous thread count: downloads run on background
# threads, so /health and /progress must stay answerable throughout.
# --graceful-timeout keeps a long album from blocking a restart forever.
exec gunicorn \
    --bind 0.0.0.0:"${PORT:-9200}" \
    --worker-class gthread \
    --workers 1 \
    --threads 16 \
    --timeout 0 \
    --graceful-timeout 30 \
    server:app
