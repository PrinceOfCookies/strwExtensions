const DEFAULTS = {
  batch: 30,
  concurrency: 4,
  attributes: true,
  pageTitle: true,
  skipSame: true
};

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MAX_CHARS = 1500;
const CACHE_MAX = 8000;

const cache = new Map();

function cacheGet(lang, text) { return cache.get(lang + "\0" + text); }
function cacheSet(lang, text, out) {
  if (cache.size >= CACHE_MAX) {
    let n = CACHE_MAX / 10;
    for (const k of cache.keys()) { cache.delete(k); if (--n <= 0) break; }
  }
  cache.set(lang + "\0" + text, out);
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

let inFlight = 0;
const waiting = [];

async function slot(limit) {
  if (inFlight < limit) { inFlight++; return; }
  await new Promise((r) => waiting.push(r));
  inFlight++;
}
function release() {
  inFlight--;
  const next = waiting.shift();
  if (next) next();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(q, target, tries = 3) {
  const params = new URLSearchParams({
    client: "gtx", sl: "auto", tl: target, dt: "t", q
  });
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(ENDPOINT + "?" + params.toString());
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(400 * 2 ** i + Math.random() * 300);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (i === tries - 1) throw new Error("rate limited (" + res.status + ")");
      await sleep(700 * 2 ** i + Math.random() * 500);
      continue;
    }
    if (!res.ok) throw new Error("translate failed (" + res.status + ")");
    const data = await res.json();
    const text = (data[0] || []).map((seg) => seg[0]).filter(Boolean).join("");
    return { text, detected: data[2] || null };
  }
  throw new Error("translate failed");
}

function splitLong(text) {
  if (text.length <= MAX_CHARS) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    let i = rest.lastIndexOf(" ", MAX_CHARS);
    if (i <= 0) i = MAX_CHARS;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i);
  }
  if (rest) parts.push(rest);
  return parts;
}

async function one(text, target) {
  const chunks = splitLong(text);
  let out = "", detected = null;
  for (const c of chunks) {
    const r = await request(c, target);
    out += r.text;
    detected = detected || r.detected;
  }
  return { text: out, detected };
}

async function group(texts, target) {
  if (texts.length === 1) {
    const r = await one(texts[0], target);
    return { results: [r.text], detected: r.detected };
  }
  const joined = texts.join("\n");
  try {
    const r = await request(joined, target);
    const lines = r.text.split("\n");
    if (lines.length === texts.length) {
      return { results: lines, detected: r.detected };
    }
  } catch (e) {
  }
  const results = [];
  let detected = null;
  for (const t of texts) {
    try {
      const r = await one(t, target);
      results.push(r.text);
      detected = detected || r.detected;
    } catch (e) {
      results.push(null);
    }
  }
  return { results, detected };
}

async function translateBatch(texts, target) {
  const settings = await getSettings();
  const out = new Array(texts.length);
  const todo = [];

  texts.forEach((t, i) => {
    const hit = cacheGet(target, t);
    if (hit !== undefined) out[i] = hit;
    else todo.push({ t, i });
  });

  const groups = [];
  let cur = [], chars = 0;
  for (const item of todo) {
    const len = item.t.length + 1;
    if (cur.length && (cur.length >= settings.batch || chars + len > MAX_CHARS)) {
      groups.push(cur); cur = []; chars = 0;
    }
    cur.push(item); chars += len;
  }
  if (cur.length) groups.push(cur);

  let detected = null;
  await Promise.all(
    groups.map(async (g) => {
      await slot(settings.concurrency);
      try {
        const r = await group(g.map((x) => x.t), target);
        detected = detected || r.detected;
        g.forEach((item, k) => {
          const val = r.results[k];
          out[item.i] = val;
          if (val != null) cacheSet(target, item.t, val);
        });
      } catch (e) {
        g.forEach((item) => { out[item.i] = null; });
      } finally {
        release();
      }
    })
  );

  return { results: out, detected };
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (e) {
    return false;
  }
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch (e) {
    return null;
  }
}

async function badge(tabId, lang) {
  try {
    await chrome.action.setBadgeText({ tabId, text: lang ? lang.slice(0, 4) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#a55b48" });
  } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "tr:batch") {
    translateBatch(msg.texts, msg.target)
      .then(sendResponse)
      .catch((e) => sendResponse({ results: msg.texts.map(() => null), error: String(e.message || e) }));
    return true;
  }

  if (msg.type === "tr:settings") {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.type === "tr:clearCache") {
    cache.clear();
    sendResponse({ ok: true, cleared: true });
    return false;
  }

  if (msg.type === "tr:open") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const settings = await getSettings();
      if (!tab || !tab.id) { sendResponse({ ok: false, settings }); return; }
      const origin = originOf(tab.url || "");
      const ok = await inject(tab.id);
      if (!ok) { sendResponse({ ok: false, origin, settings, reason: "restricted" }); return; }
      const state = await chrome.tabs.sendMessage(tab.id, { type: "tr:status" }).catch(() => null);
      sendResponse({ ok: true, tabId: tab.id, origin, settings, state: state || { active: false } });
    })();
    return true;
  }

  if (msg.type === "tr:run") {
    (async () => {
      await chrome.tabs.sendMessage(msg.tabId, {
        type: msg.action === "restore" ? "tr:restore" : "tr:translate",
        target: msg.target
      }).catch(() => {});
      badge(msg.tabId, msg.action === "restore" ? "" : msg.target);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "tr:progress" && sender.tab && msg.done === msg.total) {
    badge(sender.tab.id, msg.target);
  }
  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  const origin = originOf(tab.url || "");
  if (!origin) return;
  const { autoSites = {} } = await chrome.storage.local.get("autoSites");
  const lang = autoSites[origin];
  if (!lang) { badge(tabId, ""); return; }
  if (await inject(tabId)) {
    await chrome.tabs.sendMessage(tabId, { type: "tr:translate", target: lang }).catch(() => {});
    badge(tabId, lang);
  }
});
