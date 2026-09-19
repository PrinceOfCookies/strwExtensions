(() => {
  if (window.__strwTranslate) { window.__strwTranslate.ping(); return; }

  const SKIP_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT",
                             "IFRAME", "CODE", "PRE", "SVG", "CANVAS"]);
  const SKIP_ATTR = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "CANVAS"]);
  const ATTRS = ["title", "alt", "placeholder", "aria-label"];
  const SLICE = 60;
  const HAS_LETTER = /\p{L}/u;

  const S = {
    active: false,
    busy: false,
    target: null,
    settings: { attributes: true, pageTitle: true, skipSame: true },
    nodes: [],
    originals: new WeakMap(),
    translated: new WeakMap(),
    attrs: [],
    attrSeen: new WeakMap(),
    title: null,
    translatedTitle: null,
    pending: [],
    observer: null,
    debounce: null
  };

  function usable(node) {
    const v = node.nodeValue;
    if (!v || !v.trim() || !HAS_LETTER.test(v)) return false;
    const p = node.parentElement;
    if (!p || SKIP_TEXT.has(p.tagName.toUpperCase())) return false;
    if (p.closest('[contenteditable]:not([contenteditable="false"])')) return false;
    if (p.closest("[translate=no], .notranslate")) return false;
    return true;
  }

  function textNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (usable(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function unitsFrom(root, isDocument) {
    const units = [];

    for (const node of textNodes(root)) {
      const raw = S.originals.has(node) ? S.originals.get(node) : node.nodeValue;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      const core = raw.slice(lead.length, raw.length - trail.length).replace(/\s+/g, " ");
      if (!core) continue;
      if (!S.originals.has(node)) { S.originals.set(node, raw); S.nodes.push(node); }
      units.push({
        text: core,
        write: (v) => {
          const translated = lead + v + trail;
          node.nodeValue = translated;
          S.translated.set(node, translated);
        }
      });
    }

    if (S.settings.attributes) {
      const els = root.nodeType === 1 ? [root, ...root.querySelectorAll("*")]
                                      : root.querySelectorAll("*");
      for (const el of els) {
        if (!el.getAttribute || SKIP_ATTR.has(el.tagName.toUpperCase())) continue;
        for (const a of ATTRS) {
          const v = el.getAttribute(a);
          if (!v || !v.trim() || !HAS_LETTER.test(v)) continue;
          if (el.closest && el.closest("[translate=no], .notranslate")) continue;
          let seen = S.attrSeen.get(el);
          if (!seen) { seen = new Set(); S.attrSeen.set(el, seen); }
          let source = v;
          if (seen.has(a)) {
            const rec = S.attrs.find((r) => r.el === el && r.attr === a);
            if (rec) source = rec.original; else continue;
          } else {
            seen.add(a);
            S.attrs.push({ el, attr: a, original: v, translated: null });
          }
          units.push({
            text: source.replace(/\s+/g, " ").trim(),
            write: (t) => {
              el.setAttribute(a, t);
              const rec = S.attrs.find((r) => r.el === el && r.attr === a);
              if (rec) rec.translated = t;
            }
          });
        }
      }
    }

    if (isDocument && S.settings.pageTitle && document.title.trim()) {
      if (S.title === null) S.title = document.title;
      const original = S.title;
      units.push({
        text: original.replace(/\s+/g, " ").trim(),
        write: (t) => { document.title = t; S.translatedTitle = t; }
      });
    }

    return units;
  }

  function progress(done, total) {
    try {
      chrome.runtime.sendMessage({ type: "tr:progress", done, total, target: S.target });
    } catch (e) {}
  }

  function fail(reason) {
    try { chrome.runtime.sendMessage({ type: "tr:failed", reason }); } catch (e) {}
  }

  async function run(units, target, announce) {
    if (!units.length) { if (announce) progress(1, 1); return true; }

    const byText = new Map();
    for (const u of units) {
      if (!byText.has(u.text)) byText.set(u.text, []);
      byText.get(u.text).push(u);
    }
    const unique = [...byText.keys()];
    const total = unique.length;
    let done = 0;
    if (announce) progress(0, total);

    for (let i = 0; i < unique.length; i += SLICE) {
      const slice = unique.slice(i, i + SLICE);
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: "tr:batch", texts: slice, target });
      } catch (e) {
        fail("The extension was reloaded — reopen the page and try again.");
        return false;
      }
      if (!res || res.error) {
        fail(res && res.error ? res.error : "Translation service didn't answer.");
        return false;
      }

      if (announce && i === 0 && S.settings.skipSame && res.detected &&
          res.detected.split("-")[0] === target.split("-")[0]) {
        fail("This page is already in " + target + ".");
        return false;
      }

      slice.forEach((text, k) => {
        const out = res.results[k];
        if (out == null) return;
        byText.get(text).forEach((u) => u.write(out));
      });

      done += slice.length;
      if (announce) progress(Math.min(done, total), total);
    }
    return true;
  }

  async function translatePage(target) {
    if (S.busy) return;
    S.busy = true;
    S.target = target;
    try {
      const settings = await chrome.runtime.sendMessage({ type: "tr:settings" });
      if (settings) S.settings = { ...S.settings, ...settings };
      const units = unitsFrom(document.body, true);
      const finished = await run(units, target, true);
      if (!finished) { S.target = null; return; }
      S.active = true;
      document.documentElement.setAttribute("data-strw-translated", target);
      watch(target);
    } finally {
      S.busy = false;
    }
  }

  function restore() {
    unwatch();
    for (const node of S.nodes) {
      if (S.originals.has(node) && node.nodeValue === S.translated.get(node)) {
        node.nodeValue = S.originals.get(node);
      }
    }
    for (const r of S.attrs) {
      try {
        if (r.el.getAttribute(r.attr) === r.translated) r.el.setAttribute(r.attr, r.original);
      } catch (e) {}
    }
    if (S.title !== null && document.title === S.translatedTitle) document.title = S.title;
    S.nodes = [];
    S.attrs = [];
    S.title = null;
    S.translatedTitle = null;
    S.active = false;
    S.target = null;
    document.documentElement.removeAttribute("data-strw-translated");
  }

  function watch(target) {
    unwatch();
    S.observer = new MutationObserver((records) => {
      if (!S.active || S.busy) return;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 3) { if (usable(n)) S.pending.push(n); }
          else if (n.nodeType === 1) S.pending.push(n);
        }
      }
      if (!S.pending.length) return;
      clearTimeout(S.debounce);
      S.debounce = setTimeout(() => flush(target), 400);
    });
    S.observer.observe(document.body, { childList: true, subtree: true });
  }

  function unwatch() {
    clearTimeout(S.debounce);
    if (S.observer) { S.observer.disconnect(); S.observer = null; }
    S.pending = [];
  }

  async function flush(target) {
    const roots = S.pending.filter((n) => n.isConnected);
    S.pending = [];
    if (!roots.length) return;
    const units = [];
    for (const r of roots) units.push(...unitsFrom(r, false));
    if (S.nodes.length > 4000) S.nodes = S.nodes.filter((n) => n.isConnected);
    S.busy = true;
    try { await run(units, target, false); } finally { S.busy = false; }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "tr:translate") {
      translatePage(msg.target).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "tr:restore") {
      restore();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "tr:status") {
      sendResponse({ active: S.active, target: S.target, busy: S.busy });
      return true;
    }
  });

  window.__strwTranslate = { ping: () => {}, translatePage, restore };
})();
