"""
Minimal yt-dlp HTTP service that speaks cobalt's API shape.

POST /            {"url": "...", "downloadMode": "auto|audio", "videoQuality": "1080"}
                  -> {"status": "tunnel", "url": "...", "filename": "..."}
GET  /tunnel?id=  -> streams the file, then deletes it

Why this exists: cobalt can't fetch YouTube videos Google has migrated to
SABR (its server-controlled streaming protocol). yt-dlp handles those.
Same request/response shape as cobalt so the browser extension can talk to
either backend without special-casing.
"""

import os
import re
import shutil
import secrets
import time
import uuid
from pathlib import Path
from threading import Lock, Thread
from urllib.parse import urlparse

from flask import Flask, jsonify, request, send_file
import yt_dlp

app = Flask(__name__)

API_URL = os.environ.get("API_URL", "http://localhost:9100/").rstrip("/") + "/"
WORK_DIR = Path(os.environ.get("WORK_DIR", "/tmp/ytdlp-jobs"))
MAX_AGE_SECONDS = int(os.environ.get("MAX_AGE_SECONDS", "3600"))
API_KEY = os.environ.get("API_KEY", "")
MAX_ACTIVE_JOBS = int(os.environ.get("MAX_ACTIVE_JOBS", "2"))
JOB_TIMEOUT = int(os.environ.get("JOB_TIMEOUT", "2700"))

# Proof-of-origin token provider. YouTube increasingly rejects anonymous
# requests with "Sign in to confirm you're not a bot"; a poToken is what
# gets past that. Same bgutil server cobalt uses - shared by both backends.
POT_BASE_URL = os.environ.get("POT_BASE_URL", "http://bgutil-pot:4416")

# Optional cookies.txt (Netscape format) for age-restricted or private
# videos. Only used if the file actually exists.
COOKIES_FILE = os.environ.get("COOKIES_FILE", "/cookies.txt")

WORK_DIR.mkdir(parents=True, exist_ok=True)

_jobs = {}
_lock = Lock()

# Async job records, keyed by id:
#   state    queued | downloading | processing | done | error
#   percent  0-100 (None while unknown)
#   speed    bytes/sec, from yt-dlp's progress hook
#   eta      seconds remaining
#   path     final file, once done
_progress = {}


@app.before_request
def authorize():
    if request.method == "OPTIONS" or request.path == "/health":
        return None
    if request.path == "/tunnel":
        supplied = request.args.get("token", "")
        expected = get_progress(request.args.get("id", "")).get("tunnel_token", "")
        if supplied and expected and secrets.compare_digest(supplied, expected):
            return None
    if not API_KEY or not secrets.compare_digest(request.headers.get("Authorization", ""),
                                                  f"Api-Key {API_KEY}"):
        return jsonify({"status": "error", "error": {"code": "error.api.unauthorized"}}), 401
    if request.content_length is not None and request.content_length > 16_384:
        return jsonify({"status": "error", "error": {"code": "error.api.request_too_large"}}), 413
    return None


def active_jobs():
    with _lock:
        return sum(1 for p in _progress.values()
                   if p.get("state") in ("queued", "downloading", "processing"))


def set_progress(job_id, **fields):
    with _lock:
        cur = _progress.setdefault(job_id, {})
        cur.update(fields)


def get_progress(job_id):
    with _lock:
        return dict(_progress.get(job_id, {}))


def make_hook(job_id):
    """yt-dlp calls this repeatedly during a download."""
    def hook(d):
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            set_progress(
                job_id,
                state="downloading",
                percent=round(done / total * 100, 1) if total else None,
                downloaded=done,
                total=total,
                speed=d.get("speed"),
                eta=d.get("eta"),
            )
        elif status == "finished":
            # Merging/transcoding happens after the bytes arrive.
            set_progress(job_id, state="processing", percent=100, speed=None, eta=None)
    return hook


def sweep():
    """Delete job dirs older than MAX_AGE_SECONDS. Nothing is kept long-term."""
    now = time.time()
    for d in WORK_DIR.iterdir():
        if not d.is_dir():
            continue
        if get_progress(d.name).get("state") in ("queued", "downloading", "processing"):
            continue
        try:
            if now - d.stat().st_mtime > MAX_AGE_SECONDS:
                shutil.rmtree(d, ignore_errors=True)
                with _lock:
                    _jobs.pop(d.name, None)
                    _progress.pop(d.name, None)
        except OSError:
            pass


# Codec preference. Default is h264 (avc1) because AV1 and VP9 don't import
# into Premiere Pro, Resolve, or most NLEs without extra codec packs -
# Premiere reports "unsupported video compression type av01". This is the
# same choice cobalt made. Note YouTube only serves h264 up to 1080p; above
# that it's AV1/VP9 only, so a 1440p/4K request with codec=h264 will fall
# back to the best h264 available (usually 1080p) rather than failing.
CODEC_FILTERS = {
    "h264": "[vcodec^=avc1]",
    "av1": "[vcodec^=av01]",
    "vp9": "[vcodec^=vp9]",
    "any": "",
}


def build_format(mode, quality, codec="h264"):
    if mode == "audio":
        # m4a/AAC over opus: opus in an mp4 container upsets some editors.
        return "bestaudio[ext=m4a]/bestaudio/best"

    vf = CODEC_FILTERS.get(codec, CODEC_FILTERS["h264"])

    try:
        h = int(quality)
        hf = f"[height<={h}]"
    except (TypeError, ValueError):
        hf = ""

    # m4a audio for the same editor-compatibility reason as above.
    # Each fallback drops one constraint, so we always return something:
    # preferred codec+height -> preferred codec any height -> anything.
    return (
        f"bv*{vf}{hf}+ba[ext=m4a]/"
        f"bv*{vf}{hf}+ba/"
        f"b{vf}{hf}/"
        f"bv*{vf}+ba/"
        f"b{vf}/"
        f"bv*{hf}+ba/"
        f"b{hf}/"
        f"bv*+ba/b"
    )


def cors(resp):
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


@app.route("/", methods=["POST"])
def create():
    sweep()

    if active_jobs() >= MAX_ACTIVE_JOBS:
        return jsonify({"status": "error", "error": {"code": "error.api.busy"}}), 429

    data = request.get_json(silent=True) or {}
    url = data.get("url")
    if not url:
        return jsonify({"status": "error", "error": {"code": "error.api.link.missing"}}), 400
    parsed = urlparse(str(url))
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return jsonify({"status": "error", "error": {"code": "error.api.link.invalid"}}), 400

    mode = data.get("downloadMode", "auto")
    quality = data.get("videoQuality", "1080")
    codec = data.get("videoCodec", os.environ.get("DEFAULT_CODEC", "h264"))
    audio_format = data.get("audioFormat", "mp3")
    audio_bitrate = str(data.get("audioBitrate", "320"))
    if mode not in ("auto", "audio"):
        return jsonify({"status": "error", "error": {"code": "error.api.mode.invalid"}}), 400
    if audio_format not in ("mp3", "m4a", "opus", "wav", "flac"):
        return jsonify({"status": "error", "error": {"code": "error.api.audio_format.invalid"}}), 400
    if audio_bitrate not in ("best", "128", "192", "256", "320"):
        return jsonify({"status": "error", "error": {"code": "error.api.audio_bitrate.invalid"}}), 400

    job_id = uuid.uuid4().hex
    tunnel_token = secrets.token_urlsafe(32)
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    opts = {
        "format": build_format(mode, quality, codec),
        "outtmpl": str(job_dir / "%(title).150s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "socket_timeout": 30,
        # Single merged file the browser can just save.
        "merge_output_format": "mp4",
        "extractor_args": {
            "youtubepot-bgutilhttp": {"base_url": [POT_BASE_URL]},
        },
    }

    if os.path.isfile(COOKIES_FILE):
        opts["cookiefile"] = COOKIES_FILE

    if mode == "audio":
        pp = {"key": "FFmpegExtractAudio", "preferredcodec": audio_format}
        # "best" means keep the source bitrate; otherwise transcode to the
        # requested kbps. m4a/opus copy through where possible.
        if audio_bitrate != "best":
            pp["preferredquality"] = audio_bitrate
        opts["postprocessors"] = [pp]
        opts.pop("merge_output_format", None)

    def work():
        deadline = time.monotonic() + JOB_TIMEOUT
        def timeout_hook(_):
            if time.monotonic() > deadline:
                raise yt_dlp.utils.DownloadError("job exceeded the time limit")
        opts["progress_hooks"] = [make_hook(job_id), timeout_hook]
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as e:
            msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))[:300]
            set_progress(job_id, state="error", code="error.ytdlp.failed", message=msg)
            shutil.rmtree(job_dir, ignore_errors=True)
            return
        except Exception as e:  # noqa: BLE001
            set_progress(job_id, state="error", code="error.internal", message=str(e)[:300])
            shutil.rmtree(job_dir, ignore_errors=True)
            return

        files = [p for p in job_dir.iterdir() if p.is_file()]
        if not files:
            set_progress(job_id, state="error", code="error.ytdlp.no_output",
                         message="yt-dlp produced no file")
            shutil.rmtree(job_dir, ignore_errors=True)
            return

        # If yt-dlp left several files, the biggest is the media.
        media = max(files, key=lambda p: p.stat().st_size)
        with _lock:
            _jobs[job_id] = str(media)
        set_progress(
            job_id,
            state="done",
            percent=100,
            speed=None,
            eta=None,
            filename=media.name,
            size=media.stat().st_size,
            url=f"{API_URL}tunnel?id={job_id}&token={tunnel_token}",
        )

    set_progress(job_id, state="queued", percent=None, tunnel_token=tunnel_token)
    Thread(target=work, daemon=True).start()

    # Returns immediately; the client polls /progress and then fetches the
    # tunnel URL once state is "done".
    return jsonify({
        "status": "job",
        "id": job_id,
        "progress": f"{API_URL}progress?id={job_id}",
    })


@app.route("/progress", methods=["GET"])
def progress():
    job_id = request.args.get("id", "")
    p = get_progress(job_id)
    if not p:
        return jsonify({"state": "unknown"}), 404
    p.pop("tunnel_token", None)
    return jsonify(p)


@app.route("/tunnel", methods=["GET"])
def tunnel():
    job_id = request.args.get("id", "")
    with _lock:
        path = _jobs.get(job_id)

    if not path or not Path(path).is_file():
        # Plain text, not JSON: a JSON body here gets saved by the browser
        # as "tunnel.json" instead of showing an error.
        return ("this download is no longer available (already fetched, "
                "expired, or the job was lost)", 410,
                {"Content-Type": "text/plain; charset=utf-8"})

    p = Path(path)
    resp = send_file(p, as_attachment=True, download_name=p.name, conditional=True)

    @resp.call_on_close
    def _cleanup():
        # Stateless like cobalt: nothing is retained after it's been sent.
        shutil.rmtree(p.parent, ignore_errors=True)
        with _lock:
            _jobs.pop(job_id, None)
            _progress.pop(job_id, None)

    return resp


@app.route("/health", methods=["GET"])
def health():
    try:
        import bgutil_ytdlp_pot_provider  # noqa: F401
        pot_plugin = True
    except ImportError:
        pot_plugin = False

    return jsonify({
        "status": "ok",
        "yt_dlp": yt_dlp.version.__version__,
        "pot_plugin": pot_plugin,
        "pot_url": POT_BASE_URL,
        "cookies": os.path.isfile(COOKIES_FILE),
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "9100")), threaded=True)
