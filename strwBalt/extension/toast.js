// In-page toast, shown top-left. Injected on every page so downloads
// started from the popup or right-click menu can report back visually
// without using OS notifications.

const HOST_ID = "strwbalt-toast-host";
const LIFETIME = 4200;
const LIFETIME_PROGRESS = 2200;

function host() {
  let el = document.getElementById(HOST_ID);
  if (el) return el.shadowRoot;

  el = document.createElement("div");
  el.id = HOST_ID;
  // Shadow DOM so page CSS can't restyle the toast and vice versa.
  const root = el.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .wrap {
      position: fixed;
      top: 18px;
      left: 18px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    }
    .toast {
      display: flex;
      align-items: stretch;
      gap: 12px;
      max-width: 460px;
      padding: 12px 20px 12px 14px;
      background: #000;
      border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,.45);
      opacity: 0;
      transform: translateX(-14px);
      transition: opacity .28s ease, transform .28s cubic-bezier(.2,.7,.3,1);
    }
    .toast.in { opacity: 1; transform: translateX(0); }
    .toast.out { opacity: 0; transform: translateX(-10px); }

    .accent {
      width: 5px;
      border-radius: 3px;
      background: #a55b48;
      flex: none;
    }
    .body { display: flex; flex-direction: column; justify-content: center; }
    .brand { font-size: 12px; letter-spacing: .2px; margin-bottom: 2px; }
    .brand .a { color: #a55b48; }
    .brand .b { color: #9a9aa2; }
    .msg {
      color: #fff;
      font-size: 21px;
      line-height: 1.15;
      word-break: break-word;
    }
    .msg.err { color: #ff9797; }
    .msg.ok  { color: #a7ffb3; }
    /* no variant = work in progress, plain white */
  `;
  root.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  root.appendChild(wrap);

  (document.body || document.documentElement).appendChild(el);
  return root;
}

function toast(message, variant) {
  const root = host();
  const life = variant ? LIFETIME : LIFETIME_PROGRESS;
  const wrap = root.querySelector(".wrap");

  const t = document.createElement("div");
  t.className = "toast";

  const accent = document.createElement("div");
  accent.className = "accent";

  const body = document.createElement("div");
  body.className = "body";

  const brand = document.createElement("div");
  brand.className = "brand";
  const a = document.createElement("span");
  a.className = "a";
  a.textContent = "strw";
  const b = document.createElement("span");
  b.className = "b";
  b.textContent = "Balt";
  brand.append(a, b);

  const msg = document.createElement("div");
  msg.className = "msg" + (variant ? " " + variant : "");
  msg.textContent = message;

  body.append(brand, msg);
  t.append(accent, body);
  wrap.appendChild(t);

  requestAnimationFrame(() => t.classList.add("in"));

  setTimeout(() => {
    t.classList.remove("in");
    t.classList.add("out");
    setTimeout(() => t.remove(), 320);
  }, life);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "toast") toast(msg.text, msg.variant);
});
