const $ = (id) => document.getElementById(id);

const LANGS = [
  ["ar", "arabic — العربية"], ["bg", "bulgarian — български"], ["cs", "czech — čeština"],
  ["da", "danish — dansk"], ["de", "german — deutsch"], ["el", "greek — eλληνικά"],
  ["en", "english"], ["es", "spanish — español"], ["et", "estonian — eesti"],
  ["fa", "persian — فارسی"], ["fi", "finnish — suomi"], ["fr", "french — français"],
  ["he", "hebrew — עברית"], ["hi", "hindi — हिन्दी"], ["hr", "froatian — hrvatski"],
  ["hu", "hungarian — magyar"], ["id", "hndonesian — indonesia"], ["it", "italian — italiano"],
  ["ja", "japanese — 日本語"], ["ko", "korean — 한국어"], ["lt", "lithuanian — lietuvių"],
  ["lv", "latvian — latviešu"], ["nl", "dutch — nederlands"], ["no", "norwegian — norsk"],
  ["pl", "polish — polski"], ["pt", "portuguese — português"], ["pt-br", "portuguese (brazil)"],
  ["ro", "romanian — română"], ["ru", "russian — русский"], ["sk", "slovak — slovenčina"],
  ["sl", "slovenian — slovenščina"], ["sr", "serbian — српски"], ["sv", "swedish — svenska"],
  ["th", "thai — ไทย"], ["tr", "turkish — türkçe"], ["uk", "ukrainian — українська"],
  ["vi", "vietnamese — tiếng Việt"], ["zh-cn", "chinese (simpl.) — 简体中文"],
  ["zh-TW", "chinese (trad.) — 繁體中文"]
];

const state = { tabId: null, origin: null, active: false, recent: [] };

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) =>
      p.classList.toggle("active", p.dataset.panel === btn.dataset.tab)
    );
    if (btn.dataset.tab === "sites") renderRules();
  });
});

function msg(text, kind) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function fillLangs(filter) {
  const q = (filter || "").trim().toLowerCase();
  const keep = LANGS.filter(([code, name]) =>
    !q || name.toLowerCase().includes(q) || code.toLowerCase().startsWith(q)
  );
  const recent = state.recent.filter((c) => keep.some(([code]) => code === c));
  const rest = keep.filter(([code]) => !recent.includes(code));
  const label = (c) => (LANGS.find(([code]) => code === c) || [c, c])[1];

  const sel = $("lang");
  const previous = sel.value;
  sel.innerHTML =
    recent.map((c) => `<option class="recent" value="${c}">${label(c)}</option>`).join("") +
    rest.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");

  if (previous && keep.some(([c]) => c === previous)) sel.value = previous;
  else if (recent.length) sel.value = recent[0];
}

$("lang-filter").addEventListener("input", () => fillLangs($("lang-filter").value));

async function remember(code) {
  state.recent = [code, ...state.recent.filter((c) => c !== code)].slice(0, 3);
  await chrome.storage.local.set({ recent: state.recent, lastLang: code });
}

function setPageState({ active, target, restricted }) {
  const dot = $("dot-page");
  const line = $("page-state");
  dot.className = "dot";
  line.className = "route";

  if (restricted) {
    dot.classList.add("bad");
    line.classList.add("bad");
    line.textContent = "chrome blocks extensions on this page";
    $("go").disabled = true;
    $("restore").disabled = true;
    return;
  }
  state.active = !!active;
  $("restore").disabled = !active;
  if (active) {
    dot.classList.add("ok");
    line.textContent = "translated to " + target;
  } else {
    dot.classList.add("warn");
    line.classList.add("muted");
    line.textContent = "original text";
  }
}

function showProgress(done, total) {
  $("progress-wrap").style.display = "";
  const wrap = $("progress-wrap").querySelector(".bar");
  if (!total) {
    wrap.classList.add("indet");
    $("bar-count").textContent = "";
  } else {
    wrap.classList.remove("indet");
    $("bar").style.width = Math.round((done / total) * 100) + "%";
    $("bar-count").textContent = done + " / " + total;
  }
  $("bar-label").textContent = done >= total && total ? "done" : "translating";
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "tr:progress") {
    showProgress(m.done, m.total);
    if (m.total && m.done >= m.total) {
      setPageState({ active: true, target: m.target });
      msg("Page translated.", "ok");
      setTimeout(() => { $("progress-wrap").style.display = "none"; }, 1200);
    }
  }
  if (m.type === "tr:failed") {
    $("progress-wrap").style.display = "none";
    $("go").disabled = false;
    msg(m.reason, "warn");
  }
});

$("go").addEventListener("click", async () => {
  const target = $("lang").value;
  if (!state.tabId) return;
  const { privacyAcknowledged = false } = await chrome.storage.local.get("privacyAcknowledged");
  if (!privacyAcknowledged) {
    const accepted = confirm(
      "This sends visible page text, titles, alt text, placeholders, and labels to Google Translate. Continue?"
    );
    if (!accepted) return;
    await chrome.storage.local.set({ privacyAcknowledged: true });
  }
  await remember(target);
  msg("");
  $("go").disabled = true;
  showProgress(0, 0);
  await chrome.runtime.sendMessage({ type: "tr:run", tabId: state.tabId, target });
  $("go").disabled = false;
});

$("restore").addEventListener("click", async () => {
  if (!state.tabId) return;
  await chrome.runtime.sendMessage({ type: "tr:run", tabId: state.tabId, action: "restore" });
  $("progress-wrap").style.display = "none";
  setPageState({ active: false });
  msg("Original text restored.", "ok");
});

async function renderRules() {
  const { autoSites = {} } = await chrome.storage.local.get("autoSites");
  const entries = Object.entries(autoSites);
  const list = $("rule-list");

  $("auto-site").checked = !!(state.origin && autoSites[state.origin]);
  $("auto-label").textContent = state.origin
    ? "always translate " + state.origin.replace(/^https?:\/\//, "")
    : "translate this site automatically";
  $("auto-site").disabled = !state.origin;

  $("rules-count").textContent = entries.length
    ? `${entries.length} automatic site${entries.length > 1 ? "s" : ""}`
    : "automatic sites";

  if (!entries.length) {
    list.innerHTML = `<li class="empty">no sites translate on their own yet.</li>`;
    return;
  }
  list.innerHTML = entries
    .map(
      ([origin, lang]) => `
      <li>
        <span class="l-name">${origin.replace(/^https?:\/\//, "")}</span>
        <span class="l-badge">${lang}</span>
        <button class="link" data-origin="${origin}">remove</button>
      </li>`
    )
    .join("");

  list.querySelectorAll("button[data-origin]").forEach((b) =>
    b.addEventListener("click", async () => {
      const { autoSites = {} } = await chrome.storage.local.get("autoSites");
      delete autoSites[b.dataset.origin];
      await chrome.storage.local.set({ autoSites });
      renderRules();
    })
  );
}

$("auto-site").addEventListener("change", async () => {
  if (!state.origin) return;
  const { autoSites = {} } = await chrome.storage.local.get("autoSites");
  if ($("auto-site").checked) autoSites[state.origin] = $("lang").value;
  else delete autoSites[state.origin];
  await chrome.storage.local.set({ autoSites });
  renderRules();
});

$("clear-rules").addEventListener("click", async () => {
  await chrome.storage.local.set({ autoSites: {} });
  renderRules();
});

function bindSettings(s) {
  $("set-batch").value = String(s.batch);
  $("set-concurrency").value = String(s.concurrency);
  $("set-attributes").checked = s.attributes;
  $("set-title").checked = s.pageTitle;
  $("set-skip").checked = s.skipSame;
}

async function saveSettings() {
  await chrome.storage.local.set({
    settings: {
      batch: Number($("set-batch").value),
      concurrency: Number($("set-concurrency").value),
      attributes: $("set-attributes").checked,
      pageTitle: $("set-title").checked,
      skipSame: $("set-skip").checked
    }
  });
}

["set-batch", "set-concurrency", "set-attributes", "set-title", "set-skip"].forEach((id) =>
  $(id).addEventListener("change", saveSettings)
);

$("clear-cache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "tr:clearCache" });
  msg("cache cleared.", "ok");
});

(async () => {
  const stored = await chrome.storage.local.get(["recent", "lastLang"]);
  state.recent = stored.recent || (stored.lastLang ? [stored.lastLang] : ["en"]);
  fillLangs("");

  const res = await chrome.runtime.sendMessage({ type: "tr:open" }).catch(() => null);
  const s = (res && res.settings) || {};
  bindSettings({ batch: 30, concurrency: 4, attributes: true, pageTitle: true, skipSame: true, ...s });

  if (!res || !res.ok) {
    $("origin").textContent = (res && res.origin) || "this page";
    setPageState({ restricted: true });
    return;
  }

  state.tabId = res.tabId;
  state.origin = res.origin;
  $("origin").textContent = res.origin ? res.origin.replace(/^https?:\/\//, "") : "this page";
  setPageState(res.state || { active: false });
})();
