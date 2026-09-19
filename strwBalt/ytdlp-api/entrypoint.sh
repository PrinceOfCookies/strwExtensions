#!/bin/sh
# yt-dlp needs to stay current - YouTube changes break extraction regularly,
# and staying up to date is most of what makes yt-dlp reliable. Set
# AUTO_UPDATE=0 to skip (e.g. if you're offline).
if [ "${AUTO_UPDATE:-1}" = "1" ]; then
    echo "[entrypoint] updating yt-dlp..."
    pip install --no-cache-dir -U yt-dlp bgutil-ytdlp-pot-provider || echo "[entrypoint] update failed, using bundled versions"
fi

echo "[entrypoint] yt-dlp version: $(python -c 'import yt_dlp; print(yt_dlp.version.__version__)')"

# MUST stay at one worker. Job state (_jobs, _progress) lives in memory,
# so with two workers a /tunnel or /progress request can land on the
# process that never ran the job - it returns a 404 JSON body, which Chrome
# saves as "tunnel.json" and reports as SERVER_BAD_CONTENT.
# Concurrency comes from threads instead.
exec gunicorn \
    --bind 0.0.0.0:"${PORT:-9100}" \
    --worker-class gthread \
    --workers 1 \
    --threads 16 \
    --timeout 0 \
    --graceful-timeout 30 \
    server:app
