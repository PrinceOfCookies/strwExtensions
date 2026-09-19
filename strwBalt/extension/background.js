// Talks to your cobalt instance and hands the resulting tunnel URL to
// Chrome's download manager. Deliberately does NOT ask cobalt for local
// processing: letting the server merge video+audio avoids needing
// SharedArrayBuffer / cross-origin isolation in the browser entirely.

// Sites routed to yt-dlp instead of cobalt. Matches the hostname or any
// subdomain of it. Editable in Options, so you can add a site yourself when
// cobalt struggles with one.
//   - youtube: cobalt can't fetch videos moved to SABR (returns empty files)
//   - instagram: cobalt returns only the thumbnail for some reels, even
//     with account cookies loaded
const DEFAULT_YTDLP_HOSTS = [
  "youtube.com",
  "youtu.be",
  "instagram.com"
];

function hostMatches(hostname, pattern) {
  return hostname === pattern || hostname.endsWith("." + pattern);
}

function useYtdlpFor(pageUrl, hosts) {
  try {
    const h = new URL(pageUrl).hostname;
    return hosts.some((p) => hostMatches(h, p));
  } catch {
    return false;
  }
}

// Spotify goes to spotdl, which reads Spotify metadata and pulls the
// matching audio from YouTube.
const SPOTIFY_HOSTS = ["open.spotify.com", "spotify.com", "spotify.link"];

function isSpotify(pageUrl) {
  try {
    const h = new URL(pageUrl).hostname;
    return SPOTIFY_HOSTS.some((p) => hostMatches(h, p));
  } catch {
    return false;
  }
}

const DEFAULTS = {
  // cobalt handles ~20 platforms well, but can't fetch YouTube videos that
  // Google has migrated to SABR (its server-controlled streaming protocol).
  // yt-dlp handles those, so YouTube links go to the yt-dlp backend and
  // everything else to cobalt.
  apiUrl: "http://localhost:9000/",
  ytdlpUrl: "http://localhost:9100/",
  videoQuality: "1080",
  // h264 imports into Premiere/Resolve without extra codecs. AV1 does not
  // ("unsupported video compression type av01"). YouTube caps h264 at 1080p.
  videoCodec: "h264",
  ytdlpHosts: DEFAULT_YTDLP_HOSTS,
  spotdlUrl: "http://localhost:9200/",
  audioFormat: "mp3",
  audioBitrate: "320",
  showPlayerButton: true,
  apiKey: ""
};

async function config() {
  return await chrome.storage.sync.get(DEFAULTS);
}

// Last resort: without this, a stray rejection is attributed to whichever
// listener happened to be on the stack, which makes it very hard to find.
self.addEventListener("unhandledrejection", (e) => {
  console.error("[strwBalt] unhandled rejection:", e.reason);
});

const LOG_KEY = "log";
const LOG_MAX = 300;

// Everything the extension does lands here, visible in the popup's logs
// tab. Levels: info | ok | warn | error.
async function log(level, message, detail) {
  const entry = { ts: Date.now(), level, message: String(message).slice(0, 300) };
  if (detail) entry.detail = String(detail).slice(0, 500);

  const store = await chrome.storage.local.get({ [LOG_KEY]: [] });
  const list = store[LOG_KEY];
  list.unshift(entry);
  await chrome.storage.local.set({ [LOG_KEY]: list.slice(0, LOG_MAX) });

  chrome.runtime.sendMessage({ type: "log-update" }).catch(() => {});
  console.log(`[strwBalt:${level}] ${message}${detail ? " — " + detail : ""}`);
}

// In-page toast rather than an OS notification. Falls back silently on
// pages where content scripts can't run (chrome://, the web store).
async function notify(title, message, variant) {
  const text = message ? `${title}: ${message}` : title;

  // NOTE: do NOT use { currentWindow: true } here. In a service worker
  // there is no "current window", so that query returns nothing and the
  // toast is silently never sent. lastFocusedWindow is the correct one,
  // with a plain active-tab query as a fallback.
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) tabs = await chrome.tabs.query({ active: true });
  } catch {
    return;
  }

  for (const tab of tabs) {
    if (!tab?.id || !/^https?:/.test(tab.url || "")) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "toast", text, variant });
      return; // delivered
    } catch {
      // no content script in that tab (not reloaded since install);
      // try the next candidate
    }
  }

  console.warn("[strwBalt] toast not delivered — no reachable tab. " +
               "Refresh the page if it was open before the extension loaded.");
}

// We deliberately do NOT pass a `filename` to chrome.downloads.download.
// Chrome validates that parameter more strictly than the filesystem does,
// and titles containing apostrophes, commas or parentheses (e.g.
// "Banned From Garry's Mod 16 - Jameskii (1080p, h264).mp4") could result
// in a 0-byte file being written instead of a clean error.
//
// It costs nothing: cobalt already sends a Content-Disposition header on
// every tunnel, so Chrome derives the correct name by itself.

let lastBackend = null;
// Set only while the fallback path is retrying on the other backend.
let forceBackend = null;

async function askCobalt(pageUrl, extra = {}) {
  const cfg = await config();
  const hosts = Array.isArray(cfg.ytdlpHosts) ? cfg.ytdlpHosts : DEFAULT_YTDLP_HOSTS;

  const useSpotdl = forceBackend
    ? forceBackend === "spotdl"
    : isSpotify(pageUrl) && cfg.spotdlUrl;
  const useYtdlp = !useSpotdl && (forceBackend
    ? forceBackend === "yt-dlp"
    : useYtdlpFor(pageUrl, hosts) && cfg.ytdlpUrl);

  const endpoint = useSpotdl ? cfg.spotdlUrl : useYtdlp ? cfg.ytdlpUrl : cfg.apiUrl;

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  // Only sent if you've turned on API keys via API_AUTH_REQUIRED.
  if (cfg.apiKey && !useYtdlp) headers.Authorization = `Api-Key ${cfg.apiKey}`;

  // The two backends accept different parameters. Cobalt validates its
  // request body strictly and rejects unknown keys with
  // error.api.invalid_body, so we must not send yt-dlp-only fields to it.
  const body = useSpotdl
    ? {
        url: pageUrl,
        audioFormat: cfg.audioFormat,
        audioBitrate: cfg.audioBitrate
      }
    : useYtdlp
    ? {
        url: pageUrl,
        videoQuality: cfg.videoQuality,
        videoCodec: cfg.videoCodec,
        audioFormat: cfg.audioFormat,
        audioBitrate: cfg.audioBitrate,
        ...extra
      }
    : {
        url: pageUrl,
        videoQuality: cfg.videoQuality,
        audioFormat: cfg.audioFormat,
        // cobalt takes a bare number as a string
        audioBitrate: cfg.audioBitrate === "best" ? "320" : cfg.audioBitrate,
        ...extra
      };

  lastBackend = useSpotdl ? "spotdl" : useYtdlp ? "yt-dlp" : "cobalt";
  log("info", `using ${lastBackend}`, pageUrl.slice(0, 120));
  console.log(`[strwBalt] using ${lastBackend} backend: ${endpoint}`);

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`instance returned non-JSON (HTTP ${res.status})`);
  }
  return data;
}

// Live job state, read by the popup while a download is running.
const activeJobs = new Map();

function broadcast() {
  // The popup may not be open; ignore the resulting error.
  chrome.runtime.sendMessage({ type: "progress-update" }).catch(() => {});
}

async function pollJob(base, jobId, pageUrl) {
  activeJobs.set(jobId, { url: pageUrl, state: "queued", percent: null });
  broadcast();

  const started = Date.now();
  const TIMEOUT_MS = 45 * 60 * 1000;

  try {
    while (Date.now() - started < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 700));

      let p;
      try {
        const res = await fetch(`${base}/progress?id=${jobId}`);
        p = await res.json();
      } catch {
        continue; // transient; keep polling
      }

      activeJobs.set(jobId, { url: pageUrl, ...p });
      broadcast();

      if (p.state === "done") {
        return { ok: true, url: p.url, filename: p.filename };
      }
      if (p.state === "error") {
        return { ok: false, error: p.message || p.code || "download failed" };
      }
      if (p.state === "unknown") {
        return { ok: false, error: "job disappeared on the server" };
      }
    }
    return { ok: false, error: "timed out after 45 minutes" };
  } finally {
    activeJobs.delete(jobId);
    broadcast();
  }
}

async function download(pageUrl, extra = {}, allowFallback = true) {
  // Immediate feedback on the button press. The follow-up toast reports
  // the outcome; without this there's a long silent gap while yt-dlp
  // resolves formats or spotdl searches.
  if (allowFallback) {
    notify(extra.downloadMode === "audio" ? "getting audio…" : "getting video…")
      .catch(() => {});
  }

  let data;
  try {
    data = await askCobalt(pageUrl, extra);
  } catch (e) {
    await log("error", "request failed", e.message);
    notify("backend unreachable", "", "err");
    return { ok: false, error: e.message };
  }

  // yt-dlp can't do instagram photo carousels, and cobalt can't do SABR
  // youtube - so if the routed backend fails, try the other one before
  // giving up. This is what makes instagram images work.
  if (data.status === "error" && allowFallback && !isSpotify(pageUrl)) {
    const cfg = await config();
    const hosts = Array.isArray(cfg.ytdlpHosts) ? cfg.ytdlpHosts : DEFAULT_YTDLP_HOSTS;
    const wasYtdlp = useYtdlpFor(pageUrl, hosts) && cfg.ytdlpUrl;
    const otherAvailable = wasYtdlp ? cfg.apiUrl : cfg.ytdlpUrl;

    if (otherAvailable) {
      await log("warn", "primary backend failed, trying the other");
      forceBackend = wasYtdlp ? "cobalt" : "yt-dlp";
      const res = await download(pageUrl, extra, false);
      forceBackend = null;
      if (res.ok) return res;
    }
  }

  if (data.status === "error") {
    const detail = data.error?.message || data.error?.code || "unknown error";
    await log("error", `${lastBackend || "backend"} failed`, detail);
    notify("download failed", "", "err");
    await addHistory({ url: pageUrl, ok: false, error: String(detail).slice(0, 200), backend: null });
    return { ok: false, error: String(detail).slice(0, 300) };
  }

  // "picker" = multiple items (carousel, or video + its thumbnail).
  // Prefer video: on Instagram an unauthenticated instance often returns
  // only the photo/thumbnail, and grabbing every item means you get a jpg
  // instead of the clip you wanted.
  if (data.status === "picker") {
    const items = data.picker || [];
    if (!items.length) {
      await log("warn", "nothing to download on that page");
      notify("nothing to download", "", "err");
      return { ok: false };
    }

    const videos = items.filter((i) => i.type === "video");
    const chosen = videos.length ? videos : items;

    if (!videos.length && items.every((i) => i.type === "photo")) {
      await log("warn", "only images returned", "no video in the picker response");
    }

    for (const item of chosen) {
      chrome.downloads.download({ url: item.url });
    }
    console.log(`[cobalt] picker: ${items.length} items, downloading ${chosen.length}`);
    return { ok: true };
  }

  // yt-dlp returns a job we poll; cobalt answers with a tunnel directly.
  if (data.status === "job") {
    const cfg2 = await config();
    const jobBase = lastBackend === "spotdl" ? cfg2.spotdlUrl : cfg2.ytdlpUrl;
    const base = jobBase.replace(/\/$/, "");
    const final = await pollJob(base, data.id, pageUrl);
    if (!final.ok) return final;
    data = {
      status: "tunnel",
      url: final.url,
      filename: final.filename
    };
  }

  if (data.status === "tunnel" || data.status === "redirect") {
    console.log("[cobalt] API response:", JSON.stringify(data, null, 2));
    const id = await chrome.downloads.download({ url: data.url });
    console.log("[strwBalt] started download id:", id, "->", data.url);
    watch(id);
    await addHistory({
      url: pageUrl,
      filename: data.filename || null,
      ok: true,
      backend: lastBackend
    });
    await log("ok", "download started", data.filename || "");
    notify(data.filename ? `saving ${data.filename}` : "download started",
           "", "ok").catch(() => {});
    return { ok: true, filename: data.filename };
  }

  await log("error", "unexpected response", data.status);
  notify("unexpected response", "", "err");
  return { ok: false };
}

const HISTORY_KEY = "history";
const HISTORY_MAX = 50;

async function addHistory(entry) {
  const store = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
  const list = store[HISTORY_KEY];
  list.unshift({ ...entry, ts: Date.now() });
  await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(0, HISTORY_MAX) });
}

// Ping both backends so the popup can show whether they're reachable.
async function checkBackend(url, path) {
  if (!url) return { ok: false, detail: "not configured" };
  const ctl = new AbortController();
  // 4s was too tight: a busy backend could look dead while working fine.
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url.replace(/\/$/, "") + path, { signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      detail: data.spotdl
        ? "spotdl " + data.spotdl
        : data.yt_dlp
        ? "yt-dlp " + data.yt_dlp
        : data.cobalt?.version
          ? "cobalt " + data.cobalt.version
          : "reachable"
    };
  } catch (e) {
    return { ok: false, detail: e.name === "AbortError" ? "timed out" : "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "download") {
    download(msg.url, msg.extra || {})
      .then(sendResponse)
      .catch((e) => {
        console.error("[strwBalt] download threw:", e);
        log("error", "download failed unexpectedly", e?.message || String(e));
        sendResponse({ ok: false, error: e?.message || "unexpected error" });
      });
    return true; // keep the channel open for the async reply
  }

  if (msg?.type === "jobs") {
    sendResponse({ jobs: Array.from(activeJobs.entries()).map(([id, j]) => ({ id, ...j })) });
    return false;
  }

  if (msg?.type === "status") {
    (async () => {
      const cfg = await config();
      const [cobalt, ytdlp, spotdl] = await Promise.all([
        checkBackend(cfg.apiUrl, "/"),
        checkBackend(cfg.ytdlpUrl, "/health"),
        checkBackend(cfg.spotdlUrl, "/health")
      ]);
      sendResponse({ cobalt, ytdlp, spotdl });
    })();
    return true;
  }
});

// (the toolbar button opens popup.html; see manifest "action")

// Right-click menus, so this works on sites without a custom button.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "cobalt-video",
    title: "download video with cobalt",
    contexts: ["page", "link", "video"]
  });
  chrome.contextMenus.create({
    id: "cobalt-audio",
    title: "download audio only with cobalt",
    contexts: ["page", "link", "video"]
  });
});

// These listeners are not async, so an unhandled rejection from download()
// gets reported against this line in chrome://extensions rather than where
// it actually happened. Always attach a catch.
function safeDownload(url, extra) {
  download(url, extra).catch((e) => {
    console.error("[strwBalt] download threw:", e);
    log("error", "download failed unexpectedly", e?.message || String(e));
    notify("download failed", "", "err");
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const target = info.linkUrl || info.srcUrl || info.pageUrl || tab?.url;
  if (!target) return;
  if (info.menuItemId === "cobalt-video") safeDownload(target, {});
  if (info.menuItemId === "cobalt-audio")
    safeDownload(target, { downloadMode: "audio" });
});


// Diagnostic: report exactly how each download ends, including byte count
// and Chrome's own error string. Visible in the service worker console
// (chrome://extensions -> this extension -> "service worker").
const watched = new Set();
function watch(id) {
  watched.add(id);
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!watched.has(delta.id)) return;
  if (delta.error) {
    console.error("[strwBalt] download error:", delta.error.current);
    log("error", "chrome could not save the file", delta.error.current)
      .catch(() => {});
    notify("download failed", "", "err").catch(() => {});
  }
  if (delta.state && delta.state.current === "complete") {
    chrome.downloads.search({ id: delta.id }, (results) => {
      const d = results[0];
      console.log(
        "[cobalt] finished:",
        "bytes=", d?.bytesReceived,
        "total=", d?.totalBytes,
        "mime=", d?.mime,
        "final url=", d?.finalUrl
      );
      if (d && d.bytesReceived === 0) {
        console.error(
          "[cobalt] server returned an empty body. paste this URL into a " +
          "new tab to compare:", d.finalUrl || d.url
        );
      }
      watched.delete(delta.id);
    });
  }
  if (delta.state && delta.state.current === "interrupted") {
    console.error("[cobalt] download interrupted:", delta);
    watched.delete(delta.id);
  }
});
