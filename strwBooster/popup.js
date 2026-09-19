const $ = (id) => document.getElementById(id);

const state = { tabId: null, origin: null, value: 100, limiter: true, settings: null };

const PRESETS = [100, 150, 200, 300, 400, 600, 1000];

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) =>
      p.classList.toggle("active", p.dataset.panel === btn.dataset.tab)
    );
    if (btn.dataset.tab === "sites") renderSites();
  });
});

function paint() {
  const v = state.value;
  const max = Number($("slider").max);
  $("pct").textContent = v;
  $("slider").style.setProperty("--fill", (v / max) * 100 + "%");

  const r = $("readout");
  r.classList.remove("on", "hot", "max");
  if (v >= max) r.classList.add("max");
  else if (v > 250) r.classList.add("hot");
  else if (v > 100) r.classList.add("on");

  document.querySelectorAll(".presets button").forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.value) === v)
  );
  $("reset").disabled = v === 100;
}

function buildScale(max) {
  const stops = max <= 200 ? [0, 50, 100, 150, 200]
    : max <= 400 ? [0, 100, 200, 300, 400]
    : max <= 600 ? [0, 150, 300, 450, 600]
    : [0, 250, 500, 750, 1000];
  $("scale").innerHTML = stops.map((s) => `<span>${s}%</span>`).join("");
}

function buildPresets(max) {
  const list = PRESETS.filter((p) => p <= max).slice(0, 5);
  $("presets").innerHTML = list
    .map((p) => `<button data-value="${p}">${p}%</button>`)
    .join("");
  $("presets").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => set(Number(b.dataset.value)))
  );
}

function set(value) {
  state.value = value;
  $("slider").value = value;
  paint();
  chrome.runtime.sendMessage({
    type: "popup:set",
    tabId: state.tabId,
    origin: state.origin,
    value,
    limiter: state.limiter
  }).catch(() => {});
}

$("slider").addEventListener("input", () => set(Number($("slider").value)));
$("reset").addEventListener("click", () => set(100));
$("limiter").addEventListener("change", () => {
  state.limiter = $("limiter").checked;
  set(state.value);
});

function status({ count, silent, restricted }) {
  const dot = $("dot-audio");
  const info = $("media-info");
  dot.className = "dot";
  info.className = "route";

  if (restricted) {
    dot.classList.add("bad");
    info.classList.add("bad");
    info.textContent = "your browser blocks extensions on this page";
    $("slider").disabled = true;
    return;
  }
  if (silent) {
    dot.classList.add("bad");
    info.classList.add("bad");
    info.textContent = "this site's audio can't be hijacked";
    return;
  }
  if (!count) {
    dot.classList.add("warn");
    info.classList.add("muted");
    info.textContent = "no audio or video on this page yet";
    return;
  }
  dot.classList.add("ok");
  info.textContent = count === 1 ? "1 media element" : `${count} media elements`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "strw:update" && msg.tabId === state.tabId) {
    status({ count: msg.count, silent: msg.silent });
  }
});

async function renderSites() {
  const { sites = {} } = await chrome.storage.local.get("sites");
  const entries = Object.entries(sites).sort((a, b) => b[1] - a[1]);
  const list = $("site-list");
  $("sites-count").textContent = entries.length
    ? `${entries.length} saved site${entries.length > 1 ? "s" : ""}`
    : "saved sites";

  if (!entries.length) {
    list.innerHTML = `<li class="empty">nothing saved yet. boost a site and it lands here.</li>`;
    return;
  }
  list.innerHTML = entries
    .map(
      ([origin, value]) => `
      <li>
        <span class="l-name">${origin.replace(/^https?:\/\//, "")}</span>
        <span class="l-badge">${value}%</span>
        <button class="link" data-origin="${origin}">remove</button>
      </li>`
    )
    .join("");

  list.querySelectorAll("button[data-origin]").forEach((b) =>
    b.addEventListener("click", async () => {
      const { sites = {} } = await chrome.storage.local.get("sites");
      delete sites[b.dataset.origin];
      await chrome.storage.local.set({ sites });
      renderSites();
    })
  );
}

$("clear-sites").addEventListener("click", async () => {
  await chrome.storage.local.set({ sites: {} });
  renderSites();
});

function bindSettings(s) {
  $("set-max").value = String(s.max);
  $("set-default").value = String(s.def);
  $("set-remember").checked = s.remember;
  $("set-limiter").checked = s.limiter;
  $("set-badge").checked = s.badge;
}

async function saveSettings() {
  const s = {
    max: Number($("set-max").value),
    def: Number($("set-default").value),
    remember: $("set-remember").checked,
    limiter: $("set-limiter").checked,
    badge: $("set-badge").checked
  };
  state.settings = s;
  await chrome.storage.local.set({ settings: s });

  $("slider").max = s.max;
  buildScale(s.max);
  buildPresets(s.max);
  if (state.value > s.max) set(s.max);
  else paint();
}

["set-max", "set-default", "set-remember", "set-limiter", "set-badge"].forEach((id) =>
  $(id).addEventListener("change", saveSettings)
);

(async () => {
  const res = await chrome.runtime.sendMessage({ type: "popup:init" }).catch(() => null);
  const s = (res && res.settings) || {};
  state.settings = s;
  bindSettings({ max: 400, def: 100, remember: true, limiter: true, badge: true, ...s });

  const max = s.max || 400;
  $("slider").max = max;
  buildScale(max);
  buildPresets(max);

  if (!res || !res.ok) {
    $("origin").textContent = (res && res.origin) || "this page";
    status({ restricted: true });
    paint();
    return;
  }

  state.tabId = res.tabId;
  state.origin = res.origin;
  state.value = res.value;
  state.limiter = res.limiter;

  $("origin").textContent = res.origin ? res.origin.replace(/^https?:\/\//, "") : "this page";
  $("slider").value = res.value;
  $("limiter").checked = res.limiter;
  paint();
  status({ count: res.count, silent: res.silent });

  if (res.restored) {
    $("msg").textContent = `Restored ${res.value}% saved for this site.`;
    $("msg").className = "msg";
  }
})();
