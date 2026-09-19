"""
spotdl HTTP service, same async job shape as the yt-dlp backend.

POST /             {"url": "...", "audioFormat": "mp3", "audioBitrate": "320"}
                   -> {"status": "job", "id": "..."}
GET  /progress?id= -> {"state": ..., "percent": ..., "track": ...}
GET  /tunnel?id=   -> the file (or a zip for albums/playlists), then deletes it

Note on what spotdl actually does: it does NOT pull audio from Spotify. It
reads Spotify metadata (title, artist, album, cover art, track numbers),
finds the matching audio on YouTube, and tags the file with it. Audio
quality is therefore whatever YouTube has - the value here is clean
metadata and album/playlist handling.
"""

import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile
from pathlib import Path
from threading import Lock, Thread

from flask import Flask, jsonify, request, send_file

app = Flask(__name__)

API_URL = os.environ.get("API_URL", "http://localhost:9200/").rstrip("/") + "/"
WORK_DIR = Path(os.environ.get("WORK_DIR", "/tmp/spotdl-jobs"))
MAX_AGE_SECONDS = int(os.environ.get("MAX_AGE_SECONDS", "3600"))
POT_BASE_URL = os.environ.get("POT_BASE_URL", "")

WORK_DIR.mkdir(parents=True, exist_ok=True)


def _spotdl_version():
    """Resolved once at import. Shelling out per health check was slow
    enough that the extension's 4s timeout marked a healthy service red,
    and piled up subprocesses during downloads."""
    try:
        return subprocess.run(
            ["spotdl", "--version"], capture_output=True, text=True, timeout=30
        ).stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return None


SPOTDL_VERSION = _spotdl_version()

_files = {}
_progress = {}
_lock = Lock()


def set_progress(job_id, **fields):
    with _lock:
        _progress.setdefault(job_id, {}).update(fields)


def get_progress(job_id):
    with _lock:
        return dict(_progress.get(job_id, {}))


def sweep():
    now = time.time()
    for d in WORK_DIR.iterdir():
        if not d.is_dir():
            continue
        try:
            if now - d.stat().st_mtime > MAX_AGE_SECONDS:
                shutil.rmtree(d, ignore_errors=True)
                with _lock:
                    _files.pop(d.name, None)
                    _progress.pop(d.name, None)
        except OSError:
            pass


def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Accept"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.after_request
def _after(resp):
    return cors(resp)


@app.route("/", methods=["OPTIONS"])
@app.route("/tunnel", methods=["OPTIONS"])
@app.route("/progress", methods=["OPTIONS"])
def preflight():
    return ("", 204)


# spotdl prints "Found N songs in <name>" then a line per finished track.
RE_FOUND = re.compile(r"Found (\d+) songs?", re.I)
# spotdl sometimes phrases the total the other way round.
RE_TOTAL_ALT = re.compile(r"(\d+) songs? found", re.I)
# The most reliable signal: spotdl prints "3/12 complete" as it goes,
# giving both the count and the total in one line.
RE_COMPLETE = re.compile(r"^(\d+)\s*/\s*(\d+)\s+complete", re.I)
# Per-track status, e.g. "Artist - Title: Downloading".
RE_TRACK = re.compile(r"^(.+?): (Searching for song|Getting audio meta|Downloading|Embedding metadata|Done)$", re.I)
# Not anchored to the line start: with --simple-tui the message can carry a
# prefix. Handles both quote styles.
RE_DONE = re.compile(r"""Downloaded ["'](.+?)["']""", re.I)
RE_SKIP = re.compile(r"Skipping (.+?)(?: \(|$)", re.I)


def run_job(job_id, job_dir, url, audio_format, bitrate):
    out_tmpl = str(job_dir / "{artist} - {title}.{output-ext}")

    cmd = [
        "spotdl", "download", url,
        "--output", out_tmpl,
        "--format", audio_format,
        "--bitrate", f"{bitrate}k" if bitrate.isdigit() else "disable",
        "--print-errors",
        "--simple-tui",
    ]

    # Share the proof-of-origin provider so YouTube doesn't refuse us as a
    # bot; spotdl fetches the audio through yt-dlp underneath.
    if POT_BASE_URL:
        # No inner quotes: this is already one argv element, and the value
        # contains no spaces. Quoting it made spotdl mis-parse the flag.
        cmd += ["--yt-dlp-args",
                f"--extractor-args youtubepot-bgutilhttp:base_url={POT_BASE_URL}"]

    set_progress(job_id, state="queued", percent=None, track=None)

    try:
        # Python block-buffers stdout when it is not a terminal, so
        # progress lines never arrived until the process exited.
        env = dict(os.environ, PYTHONUNBUFFERED="1", TERM="dumb")
        proc = subprocess.Popen(
            cmd, cwd=str(job_dir),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, env=env
        )
    except FileNotFoundError:
        set_progress(job_id, state="error", code="error.spotdl.missing",
                     message="spotdl is not installed in the container")
        return

    total = None
    done = 0
    tail = []

    for line in proc.stdout:
        line = line.rstrip()
        tail.append(line)
        del tail[:-25]

        # Echo to the container log so the real wording is visible
        # if spotdl changes it again.
        print(f"[spotdl:{job_id[:6]}] {line}", flush=True)

        m = RE_FOUND.search(line) or RE_TOTAL_ALT.search(line)
        if m:
            total = int(m.group(1))
            set_progress(job_id, state="downloading", total_tracks=total,
                         tracks_done=0, percent=0)
            continue

        m = RE_COMPLETE.match(line)
        if m:
            done = int(m.group(1))
            total = int(m.group(2))
            set_progress(job_id, state="downloading", tracks_done=done,
                         total_tracks=total,
                         percent=round(done / total * 100, 1) if total else None)
            continue

        m = RE_TRACK.match(line)
        if m:
            set_progress(job_id, state="downloading", track=m.group(1)[:120],
                         step=m.group(2).lower())
            continue

        m = RE_DONE.search(line) or RE_SKIP.search(line)
        if m:
            done += 1
            set_progress(
                job_id,
                state="downloading",
                track=m.group(1)[:120],
                tracks_done=done,
                total_tracks=total,
                percent=round(done / total * 100, 1) if total else None,
            )

    # Hard ceiling so a wedged spotdl can't hold the job open forever.
    try:
        proc.wait(timeout=int(os.environ.get("JOB_TIMEOUT", "3000")))
    except subprocess.TimeoutExpired:
        proc.kill()
        set_progress(job_id, state="error", code="error.spotdl.timeout",
                     message="spotdl exceeded the time limit and was stopped")
        shutil.rmtree(job_dir, ignore_errors=True)
        return

    files = sorted(p for p in job_dir.iterdir()
                   if p.is_file() and p.suffix.lower() != ".zip")

    if not files:
        msg = "\n".join(tail[-6:]) or "spotdl produced no files"
        set_progress(job_id, state="error", code="error.spotdl.no_output",
                     message=msg[:400])
        shutil.rmtree(job_dir, ignore_errors=True)
        return

    if len(files) == 1:
        media = files[0]
    else:
        # Albums and playlists come back as a single zip so the browser
        # gets one download rather than dozens.
        set_progress(job_id, state="processing", percent=100)
        media = job_dir / (safe_zip_name(url, len(files)) + ".zip")
        with zipfile.ZipFile(media, "w", zipfile.ZIP_STORED) as z:
            for f in files:
                z.write(f, arcname=f.name)

    with _lock:
        _files[job_id] = str(media)

    set_progress(
        job_id,
        state="done",
        percent=100,
        filename=media.name,
        size=media.stat().st_size,
        tracks_done=done,
        total_tracks=total,
        url=f"{API_URL}tunnel?id={job_id}",
    )


def safe_zip_name(url, count):
    kind = "playlist"
    if "/album/" in url:
        kind = "album"
    elif "/artist/" in url:
        kind = "artist"
    return f"spotify {kind} ({count} tracks)"


@app.route("/", methods=["POST"])
def create():
    sweep()
    data = request.get_json(silent=True) or {}
    url = data.get("url")
    if not url:
        return jsonify({"status": "error",
                        "error": {"code": "error.api.link.missing"}}), 400

    audio_format = data.get("audioFormat", "mp3")
    bitrate = str(data.get("audioBitrate", "320"))

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    Thread(target=run_job,
           args=(job_id, job_dir, url, audio_format, bitrate),
           daemon=True).start()

    return jsonify({
        "status": "job",
        "id": job_id,
        "progress": f"{API_URL}progress?id={job_id}",
    })


@app.route("/progress", methods=["GET"])
def progress():
    p = get_progress(request.args.get("id", ""))
    if not p:
        return jsonify({"state": "unknown"}), 404
    return jsonify(p)


@app.route("/tunnel", methods=["GET"])
def tunnel():
    job_id = request.args.get("id", "")
    with _lock:
        path = _files.get(job_id)

    if not path or not Path(path).is_file():
        return ("this download is no longer available (already fetched, "
                "expired, or the job was lost)", 410,
                {"Content-Type": "text/plain; charset=utf-8"})

    p = Path(path)
    resp = send_file(p, as_attachment=True, download_name=p.name, conditional=True)

    @resp.call_on_close
    def _cleanup():
        shutil.rmtree(p.parent, ignore_errors=True)
        with _lock:
            _files.pop(job_id, None)
            _progress.pop(job_id, None)

    return resp


@app.route("/health", methods=["GET"])
def health():
    # Deliberately cheap: no subprocess, so this answers instantly even
    # while an album is downloading.
    with _lock:
        active = sum(1 for p in _progress.values()
                     if p.get("state") in ("queued", "downloading", "processing"))
    return jsonify({
        "status": "ok",
        "spotdl": SPOTDL_VERSION or "unknown",
        "pot_url": POT_BASE_URL or None,
        "active_jobs": active,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "9200")), threaded=True)
