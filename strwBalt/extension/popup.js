const DEFAULTS = {
  apiUrl: "http://localhost:9000/",
  ytdlpUrl: "http://localhost:9100/",
  videoQuality: "1080",
  videoCodec: "h264",
  ytdlpHosts: ["youtube.com", "youtu.be", "instagram.com"],
  spotdlUrl: "http://localhost:9200/",
  audioFormat: "mp3",
  audioBitrate: "320",
  showPlayerButton: true,
  apiKey: ""
};

// YouTube only serves h264 up to 1080p. Above that it's av1/vp9 only, so
// higher options are disabled rather than silently giving you 1080p.
const CODEC_MAX_HEIGHT = { h264: 1080 };

const CODEC_NOTES = {
  h264: "imports into premiere and resolve directly. capped at 1080p.",
  av1: "premiere can't import av01 without extra codecs.",
  vp9: "premiere can't import vp9 reliably either.",
  any: "picks the best available — may be av1 or vp9, which premiere can't import."
};

function applyCodecLimits() {
  const codec = $("videoCodec").value;
  const max = CODEC_MAX_HEIGHT[codec] || Infinity;
  const sel = $("videoQuality");

  for (const opt of sel.options) {
    const h = opt.value === "max" ? Infinity : parseInt(opt.value, 10);
    opt.disabled = h > max;
  }

  // If the current pick is now unavailable, fall to the best that isn't.
  const cur = sel.value === "max" ? Infinity : parseInt(sel.value, 10);
  if (cur > max) {
    const next = [...sel.options].find((o) => !o.disabled);
    if (next) sel.value = next.value;
  }

  $("codec-hint").textContent = CODEC_NOTES[codec] || "";
}

const $ = (id) => document.getElementById(id);
let currentUrl = null;

function hostMatches(hostname, pattern) {
  return hostname === pattern || hostname.endsWith("." + pattern);
}

const SPOTIFY_HOSTS = ["open.spotify.com", "spotify.com", "spotify.link"];

function routeOf(url, hosts) {
  try {
    const h = new URL(url).hostname;
    if (SPOTIFY_HOSTS.some((p) => hostMatches(h, p))) return "spotdl";
    return hosts.some((p) => hostMatches(h, p)) ? "yt-dlp" : "cobalt";
  } catch {
    return null;
  }
}

function say(el, text, cls) {
  el.textContent = text;
  el.className = "msg" + (cls ? " " + cls : "");
}

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("panel-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "history") renderHistory();
    if (btn.dataset.tab === "logs") renderLog();
  });
});

/* ---------- current tab + routing preview ---------- */
async function initCurrent() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.url && /^https?:/.test(tab.url)) {
    currentUrl = tab.url;
    $("current-url").textContent = tab.url;
    const r = routeOf(tab.url, cfg.ytdlpHosts || []);
    $("current-route").textContent = r ? `will use ${r}` : "";
  } else {
    $("current-url").textContent = "no downloadable page";
    $("dl-video").disabled = true;
    $("dl-audio").disabled = true;
  }
}

/* ---------- status ---------- */
function paintStatus(res) {
  const set = (id, s) => {
    const el = $(id);
    el.classList.toggle("ok", !!s?.ok);
    el.classList.toggle("bad", !s?.ok);
    el.title = `${el.title.split(" —")[0]} — ${s?.detail || "unknown"}`;
  };
  set("dot-cobalt", res?.cobalt);
  set("dot-ytdlp", res?.ytdlp);
  set("dot-spotdl", res?.spotdl);
}

chrome.runtime.sendMessage({ type: "status" }, (res) => {
  if (!chrome.runtime.lastError) paintStatus(res);
});

/* ---------- downloads ---------- */
function run(url, extra, btn) {
  if (!url) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "working...";
  say($("msg"), "");

  chrome.runtime.sendMessage({ type: "download", url, extra }, (res) => {
    btn.disabled = false;
    btn.textContent = original;
    refreshJobs();
    if (chrome.runtime.lastError || !res?.ok) {
      say($("msg"), res?.error || "download failed", "err");
    } else {
      say($("msg"), res.filename ? `saving ${res.filename}` : "download started", "ok");
    }
  });
}

$("dl-video").addEventListener("click", (e) => run(currentUrl, {}, e.target));
$("dl-audio").addEventListener("click", (e) =>
  run(currentUrl, { downloadMode: "audio" }, e.target)
);
$("dl-manual").addEventListener("click", (e) => {
  const u = $("manual-url").value.trim();
  if (!u) return say($("msg"), "paste a link first", "err");
  run(u, {}, e.target);
});
$("manual-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("dl-manual").click();
});

/* ---------- live progress ---------- */
function fmtSpeed(bps) {
  if (!bps) return "";
  const mbit = (bps * 8) / 1e6;
  return mbit >= 1 ? mbit.toFixed(1) + " Mbit/s" : (bps / 1024).toFixed(0) + " KB/s";
}

function fmtSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB";
}

function fmtEta(s) {
  if (s === null || s === undefined) return "";
  if (s < 60) return s + "s left";
  return Math.floor(s / 60) + "m " + (s % 60) + "s left";
}

const STATE_TEXT = {
  queued: "starting",
  downloading: "downloading",
  processing: "zipping",
  starting: "starting",
  done: "done"
};

function renderJobs(jobs) {
  const box = $("jobs");
  box.innerHTML = "";

  for (const j of jobs) {
    const el = document.createElement("div");
    el.className = "job";

    const known = typeof j.percent === "number";

    const top = document.createElement("div");
    top.className = "job-top";
    const state = document.createElement("span");
    state.className = "job-state";
    state.textContent = STATE_TEXT[j.state] || j.state || "working";
    const pct = document.createElement("span");
    pct.textContent = known ? j.percent + "%" : "";
    top.append(state, pct);

    const bar = document.createElement("div");
    bar.className = "bar" + (known ? "" : " indet");
    const fill = document.createElement("span");
    if (known) fill.style.width = j.percent + "%";
    bar.appendChild(fill);

    const bottom = document.createElement("div");
    bottom.className = "job-bottom";
    const left = document.createElement("span");
    if (j.total_tracks) {
      left.textContent = `track ${j.tracks_done || 0}/${j.total_tracks}`;
      if (j.track) left.textContent += ` — ${j.track}`;
    } else {
      left.textContent = j.total
        ? `${fmtSize(j.downloaded)} / ${fmtSize(j.total)}`
        : fmtSize(j.downloaded);
    }
    const right = document.createElement("span");
    right.textContent = j.state === "downloading"
      ? [fmtSpeed(j.speed), fmtEta(j.eta)].filter(Boolean).join(" · ")
      : "";
    bottom.append(left, right);

    el.append(top, bar, bottom);
    box.appendChild(el);
  }
}

function refreshJobs() {
  chrome.runtime.sendMessage({ type: "jobs" }, (res) => {
    if (!chrome.runtime.lastError && res) renderJobs(res.jobs || []);
  });
}

// The service worker pings when any job advances.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "progress-update") refreshJobs();
  if (msg?.type === "log-update" &&
      $("panel-logs").classList.contains("active")) renderLog();
});

refreshJobs();
setInterval(refreshJobs, 1000);

/* ---------- history ---------- */
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  const list = $("hist-list");
  list.innerHTML = "";

  $("hist-count").textContent = history.length
    ? `${history.length} recent`
    : "no downloads yet";

  for (const h of history) {
    const li = document.createElement("li");

    const name = document.createElement("div");
    name.className = "h-name";
    name.textContent = h.filename || h.url;
    li.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "h-meta";
    if (h.ok) {
      meta.innerHTML =
        `<span class="h-badge">${h.backend || "?"}</span> · ${ago(h.ts)}`;
    } else {
      meta.innerHTML = `<span class="bad">failed</span> · ${ago(h.ts)}`;
      if (h.error) meta.title = h.error;
    }
    li.appendChild(meta);
    list.appendChild(li);
  }
}

$("clear-history").addEventListener("click", async () => {
  await chrome.storage.local.set({ history: [] });
  renderHistory();
});

/* ---------- logs ---------- */
function clock(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" +
         String(d.getMinutes()).padStart(2, "0") + ":" +
         String(d.getSeconds()).padStart(2, "0");
}

async function renderLog() {
  const { log = [] } = await chrome.storage.local.get({ log: [] });
  const list = $("log-list");
  list.innerHTML = "";

  $("log-count").textContent = log.length
    ? `${log.length} entries`
    : "nothing logged yet";

  for (const e of log) {
    const li = document.createElement("li");
    li.className = "l-" + (e.level || "info");

    const time = document.createElement("span");
    time.className = "l-time";
    time.textContent = clock(e.ts);

    const body = document.createElement("div");
    body.className = "l-body";

    const msg = document.createElement("div");
    msg.className = "l-msg";
    msg.textContent = e.message;
    body.appendChild(msg);

    if (e.detail) {
      const det = document.createElement("div");
      det.className = "l-detail";
      det.textContent = e.detail;
      body.appendChild(det);
    }

    li.append(time, body);
    list.appendChild(li);
  }
}

$("clear-log").addEventListener("click", async () => {
  await chrome.storage.local.set({ log: [] });
  renderLog();
});

/* ---------- settings ---------- */
async function loadSettings() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  $("videoQuality").value = cfg.videoQuality;
  $("videoCodec").value = cfg.videoCodec;
  $("audioFormat").value = cfg.audioFormat;
  $("audioBitrate").value = cfg.audioBitrate;
  $("showPlayerButton").checked = cfg.showPlayerButton !== false;
  applyCodecLimits();
  $("ytdlpHosts").value = (cfg.ytdlpHosts || []).join("\n");
  $("apiUrl").value = cfg.apiUrl;
  $("ytdlpUrl").value = cfg.ytdlpUrl;
  $("spotdlUrl").value = cfg.spotdlUrl;
}

$("save").addEventListener("click", async () => {
  const tidy = (u) => {
    u = u.trim();
    return u && !u.endsWith("/") ? u + "/" : u;
  };

  await chrome.storage.sync.set({
    videoQuality: $("videoQuality").value,
    videoCodec: $("videoCodec").value,
    audioFormat: $("audioFormat").value,
    audioBitrate: $("audioBitrate").value,
    showPlayerButton: $("showPlayerButton").checked,
    ytdlpHosts: $("ytdlpHosts")
      .value.split("\n")
      .map((l) => l.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean),
    apiUrl: tidy($("apiUrl").value) || DEFAULTS.apiUrl,
    ytdlpUrl: tidy($("ytdlpUrl").value),
    spotdlUrl: tidy($("spotdlUrl").value)
  });

  say($("save-msg"), "saved", "ok");
  setTimeout(() => say($("save-msg"), ""), 1500);
  initCurrent();
});

$("videoCodec").addEventListener("change", applyCodecLimits);

initCurrent();
loadSettings();
