(() => {
  if (window.__strwBooster) { window.__strwBooster.report(); return; }

  const SMOOTH = 0.015;
  const CHECK_MS = 250;
  const SILENT_HITS = 5;

  let ctx = null, gain = null, limiter = null, analyser = null, frames = null;
  let boost = 1;
  let useLimiter = true;
  let silentHits = 0, silent = false;
  let timer = null, scanQueued = false;

  const wired = new WeakSet();
  const failed = new WeakSet();

  function build() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    gain = ctx.createGain();
    gain.gain.value = boost;

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 6;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    frames = new Float32Array(analyser.fftSize);

    route();
    return true;
  }

  function route() {
    try { gain.disconnect(); } catch (e) {}
    try { limiter.disconnect(); } catch (e) {}
    gain.connect(analyser);
    if (useLimiter) {
      gain.connect(limiter);
      limiter.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
  }

  function resume() {
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  function wire(el) {
    if (wired.has(el) || failed.has(el)) return;
    if (!build()) return;
    try {
      ctx.createMediaElementSource(el).connect(gain);
      wired.add(el);
    } catch (e) {
      failed.add(el);
    }
    resume();
  }

  function media() { return document.querySelectorAll("audio, video"); }

  function wireAll() {
    scanQueued = false;
    if (boost === 1 && !ctx) return;
    media().forEach(wire);
    report();
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(wireAll, 200);
  }

  function apply(value, limiterOn) {
    boost = value;
    if (typeof limiterOn === "boolean" && limiterOn !== useLimiter) {
      useLimiter = limiterOn;
      if (ctx) route();
    }
    if (value === 1 && !ctx) { report(); return; }
    wireAll();
    if (gain) {
      gain.gain.setTargetAtTime(value, ctx.currentTime, SMOOTH);
      resume();
    }
    if (value === 1) {
      silentHits = 0;
      silent = false;
      if (timer) { clearInterval(timer); timer = null; }
      report();
      return;
    }
    startWatch();
  }

  function activeMedia() {
    for (const el of media()) {
      if (!el.paused && !el.muted && el.volume > 0 && el.readyState >= 2) return el;
    }
    return null;
  }

  function watch() {
    if (!analyser || boost === 1) return;
    if (!activeMedia()) { silentHits = 0; return; }
    analyser.getFloatTimeDomainData(frames);
    let peak = 0;
    for (let i = 0; i < frames.length; i++) {
      const a = frames[i] < 0 ? -frames[i] : frames[i];
      if (a > peak) peak = a;
    }
    silentHits = peak === 0 ? silentHits + 1 : 0;
    const now = silentHits >= SILENT_HITS;
    if (now !== silent) { silent = now; report(); }
  }

  function startWatch() {
    if (timer || boost === 1) return;
    timer = setInterval(watch, CHECK_MS);
  }

  function report() {
    const els = media();
    let count = els.length;
    let playing = 0;
    for (const el of els) if (!el.paused) playing++;
    try {
      chrome.runtime.sendMessage({
        type: "strw:media",
        count,
        playing,
        boost,
        limiter: useLimiter,
        silent,
        blocked: silent
      });
    } catch (e) {}
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "AUDIO" || n.tagName === "VIDEO" ||
            (n.querySelector && n.querySelector("audio, video"))) {
          queueScan();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  ["click", "keydown", "play"].forEach((ev) =>
    document.addEventListener(ev, resume, { capture: true, passive: true })
  );

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "strw:set") {
      apply(msg.value, msg.limiter);
      sendResponse({ ok: true, boost, silent });
      return true;
    }
    if (msg.type === "strw:report") {
      report();
      return false;
    }
  });

  window.__strwBooster = { report, apply };
  report();
})();
