const DEFAULTS = {
  max: 400,
  def: 100,
  remember: true,
  limiter: true,
  badge: true
};

const live = new Map();

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

async function getSites() {
  const { sites } = await chrome.storage.local.get("sites");
  return sites || {};
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch (e) {
    return null;
  }
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    return true;
  } catch (e) {
    return false;
  }
}

function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function badgeText(value) {
  if (value === 100) return "";
  const x = value / 100;
  return (x >= 10 || Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1)) + "x";
}

async function paintBadge(tabId, value) {
  const s = await getSettings();
  const text = s.badge ? badgeText(value) : "";
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#a55b48" });
  } catch (e) {}
}

function snapshot(tabId) {
  const framesMap = live.get(tabId);
  const out = { count: 0, boost: 100, limiter: true, silent: false, seen: false };
  if (!framesMap) return out;
  for (const f of framesMap.values()) {
    out.seen = true;
    out.count += f.count;
    out.boost = Math.max(out.boost, Math.round(f.boost * 100));
    out.limiter = f.limiter;
    if (f.silent) out.silent = true;
  }
  return out;
}

async function applyBoost(tabId, value, limiter) {
  await send(tabId, { type: "strw:set", value: value / 100, limiter });
  await paintBadge(tabId, value);
}

async function rememberSite(origin, value) {
  if (!origin) return;
  const s = await getSettings();
  if (!s.remember) return;
  const sites = await getSites();
  if (value === 100) delete sites[origin];
  else sites[origin] = value;
  await chrome.storage.local.set({ sites });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "strw:media" && sender.tab) {
    const tabId = sender.tab.id;
    if (!live.has(tabId)) live.set(tabId, new Map());
    live.get(tabId).set(sender.frameId ?? 0, {
      count: msg.count,
      boost: msg.boost,
      limiter: msg.limiter,
      silent: msg.silent,
      ts: Date.now()
    });
    const snap = snapshot(tabId);
    chrome.runtime.sendMessage({ type: "strw:update", tabId, ...snap }).catch(() => {});
    return false;
  }

  if (msg.type === "popup:init") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const settings = await getSettings();
      if (!tab || !tab.id) { sendResponse({ ok: false, settings }); return; }

      const origin = originOf(tab.url || "");
      live.delete(tab.id);
      const ok = await inject(tab.id);
      if (!ok) {
        sendResponse({ ok: false, settings, origin, reason: "restricted" });
        return;
      }

      await send(tab.id, { type: "strw:report" });
      await new Promise((r) => setTimeout(r, 180));

      const sites = await getSites();
      const snap = snapshot(tab.id);
      let value = snap.boost;

      const saved = origin && settings.remember ? sites[origin] : undefined;
      let restored = false;
      if (value === 100 && saved && saved !== 100) {
        value = saved;
        restored = true;
        await applyBoost(tab.id, value, settings.limiter);
      } else {
        await paintBadge(tab.id, value);
      }

      sendResponse({
        ok: true,
        tabId: tab.id,
        origin,
        value,
        restored,
        limiter: snap.seen ? snap.limiter : settings.limiter,
        count: snap.count,
        silent: snap.silent,
        settings
      });
    })();
    return true;
  }

  if (msg.type === "popup:set") {
    (async () => {
      await applyBoost(msg.tabId, msg.value, msg.limiter);
      await rememberSite(msg.origin, msg.value);
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  const origin = originOf(tab.url || "");
  if (!origin) return;

  const settings = await getSettings();
  if (!settings.remember) return;
  const sites = await getSites();
  const saved = sites[origin];
  if (!saved || saved === 100) { paintBadge(tabId, 100); return; }

  live.delete(tabId);
  if (await inject(tabId)) await applyBoost(tabId, saved, settings.limiter);
});

chrome.tabs.onRemoved.addListener((tabId) => live.delete(tabId));
