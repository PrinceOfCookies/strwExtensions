FROM python:3.12-slim

# ffmpeg is required for merging separate video+audio streams and for
# audio extraction.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# bgutil-ytdlp-pot-provider is the yt-dlp *plugin* half of the same tool
# the bgutil-pot container runs. Without it, YouTube answers with
# "Sign in to confirm you're not a bot".
RUN pip install --no-cache-dir flask gunicorn yt-dlp bgutil-ytdlp-pot-provider

WORKDIR /app
COPY server.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 9100
ENTRYPOINT ["./entrypoint.sh"]
