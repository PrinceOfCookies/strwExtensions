FROM python:3.12-slim

# ffmpeg does the audio conversion and tagging.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# bgutil plugin so the yt-dlp underneath spotdl can present a
# proof-of-origin token; without it YouTube may refuse as a bot.
RUN pip install --no-cache-dir flask gunicorn spotdl bgutil-ytdlp-pot-provider

WORKDIR /app
COPY server.py test_server.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 9200
ENTRYPOINT ["./entrypoint.sh"]
