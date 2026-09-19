// Injects a download button into YouTube's player controls.
// YouTube is a single-page app, so the button has to survive navigation
// and player re-renders - hence the observer plus the navigate event.

const BTN_ID = "cobalt-dl-btn";

const ICON_IDLE = `<svg height="100%" viewBox="0 0 24 24" width="100%" fill="white">
<path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.7 1.4-1.4 3.3 3.3V3h2zM5 19h14v2H5z"/></svg>`;
const ICON_BUSY = `<svg height="100%" viewBox="0 0 24 24" width="100%" fill="white">
<path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"><animateTransform
attributeName="transform" type="rotate" from="0 12 12" to="360 12 12"
dur="0.8s" repeatCount="indefinite"/></path></svg>`;
const ICON_DONE = `<svg height="100%" viewBox="0 0 24 24" width="100%" fill="#5ad46a">
<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`;
const ICON_FAIL = `<svg height="100%" viewBox="0 0 24 24" width="100%" fill="#ff6b6b">
<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg>`;

function setState(btn, state) {
  if (state === "busy") {
    btn.innerHTML = ICON_BUSY;
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  if (state === "done") {
    btn.innerHTML = ICON_DONE;
    setTimeout(() => setState(btn, "idle"), 2500);
  } else if (state === "fail") {
    btn.innerHTML = ICON_FAIL;
    setTimeout(() => setState(btn, "idle"), 2500);
  } else {
    btn.innerHTML = ICON_IDLE;
  }
}

function makeButton() {
  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.className = "ytp-button cobalt-dl-btn";
  btn.title = "download with cobalt (alt+click for audio only)";
  setState(btn, "idle");

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setState(btn, "busy");
    // Strip playlist/index noise so cobalt gets a clean video URL.
    const id = new URLSearchParams(location.search).get("v");
    const url = id
      ? `https://www.youtube.com/watch?v=${id}`
      : location.href;
    const extra = e.altKey ? { downloadMode: "audio" } : {};

    chrome.runtime.sendMessage({ type: "download", url, extra }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) setState(btn, "fail");
      else setState(btn, "done");
    });
  });

  return btn;
}

function inject() {
  const controls = document.querySelector(".ytp-right-controls");
  if (!controls || document.getElementById(BTN_ID)) return;
  // Sit to the left of the settings gear rather than at the very end.
  controls.insertBefore(makeButton(), controls.firstChild);
}

let enabled = true;

function remove() {
  document.getElementById(BTN_ID)?.remove();
}

function apply() {
  if (enabled) inject();
  else remove();
}

const observer = new MutationObserver(() => apply());
observer.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener("yt-navigate-finish", apply);

chrome.storage.sync.get({ showPlayerButton: true }, (cfg) => {
  enabled = cfg.showPlayerButton !== false;
  apply();
});

// React immediately when the setting is toggled in the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.showPlayerButton) {
    enabled = changes.showPlayerButton.newValue !== false;
    apply();
  }
});
