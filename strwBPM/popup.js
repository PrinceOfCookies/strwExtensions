const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  matchStrictness: 'balanced',
  alwaysAnalyse: true,
  preferSource: 'auto',
  spotifyClientId: '',
  spotifyClientSecret: '',
};

function say(el, text, cls = '') {
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('panel-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'history') renderHistory();
    if (btn.dataset.tab === 'logs') renderLogs();
  });
});

function toMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const n = buffer.length;
  const mono = new Float32Array(n);
  let sumEnergy = 0, lEnergy = 0;
  for (let i = 0; i < n; i++) {
    const m = (l[i] + r[i]) / 2;
    mono[i] = m;
    sumEnergy += m * m;
    lEnergy += l[i] * l[i];
  }
  if (lEnergy > 0 && sumEnergy < lEnergy * 0.05) return l;
  return mono;
}

async function analysePreview(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`preview fetch returned ${res.status}`);
  const bytes = await res.arrayBuffer();

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    const mono = toMono(buffer);
    const out = analyzeBuffer(mono, buffer.sampleRate);
    out.seconds = Math.round(buffer.duration * 10) / 10;
    return out;
  } finally {
    ctx.close();
  }
}

function setDots(result) {
  $('dot-deezer').className = 'dot ' + (result?.catalogue ? 'up' : 'down');
  $('dot-itunes').className = 'dot ' + (result?.preview?.from === 'iTunes' ? 'up' : '');
}

function render(state) {
  const { track, catalogue, analysis, chosen, preview } = state;

  $('result').classList.remove('hidden');
  $('t-title').textContent = track.title || '—';
  $('t-artist').textContent = track.artist || '';
  if (track.artwork) { $('art').src = track.artwork; $('art').style.visibility = 'visible'; }
  else { $('art').removeAttribute('src'); $('art').style.visibility = 'hidden'; }

  $('bpm').textContent = chosen?.bpm != null ? chosen.bpm : '—';

  const k = analysis?.key;
  if (k) {
    $('key-chip').style.visibility = 'visible';
    $('key-name').textContent = k.key;
    $('key-camelot').textContent = k.camelot;
    $('key-chip').title = `estimated key, ${Math.round(k.confidence * 100)}% fit to a ${k.key.endsWith('m') ? 'minor' : 'major'} profile`;
  } else {
    $('key-chip').style.visibility = 'hidden';
  }

  const half = chosen?.bpm != null ? Math.round((chosen.bpm / 2) * 10) / 10 : null;
  const dbl = chosen?.bpm != null ? Math.round(chosen.bpm * 2 * 10) / 10 : null;
  $('halftime').textContent = half ? `${half} / ${dbl} half & double` : '';

  if (chosen?.from === 'analysis' && analysis?.tempo) {
    $('conf-wrap').classList.remove('hidden');
    const pct = Math.round(analysis.tempo.confidence * 100);
    $('conf-label').textContent = 'analysis confidence';
    $('conf-pct').textContent = pct + '%';
    $('conf-fill').style.width = pct + '%';
  } else {
    $('conf-wrap').classList.add('hidden');
  }

  const rows = [];
  if (catalogue?.bpm != null) rows.push({ label: `${catalogue.source} catalogue`, val: catalogue.bpm });
  else if (catalogue) rows.push({ label: `${catalogue.source} catalogue`, val: 'no BPM stored' });
  if (analysis?.tempo?.bpm != null) {
    rows.push({ label: `analysed ${preview?.from || ''} preview`.trim(), val: analysis.tempo.bpm });
  }

  const disagree =
    catalogue?.bpm != null && analysis?.tempo?.bpm != null &&
    Math.abs(catalogue.bpm - analysis.tempo.bpm) / catalogue.bpm > 0.02 &&
    Math.abs(catalogue.bpm - analysis.tempo.bpm * 2) / catalogue.bpm > 0.02 &&
    Math.abs(catalogue.bpm - analysis.tempo.bpm / 2) / catalogue.bpm > 0.02;

  $('sources').innerHTML = '';
  for (const r of rows) {
    const d = document.createElement('div');
    d.className = 'src' + (disagree ? ' disagree' : '');
    const a = document.createElement('span'); a.textContent = r.label;
    const b = document.createElement('b'); b.textContent = r.val;
    d.append(a, b);
    $('sources').appendChild(d);
  }

  const notes = [];
  if (catalogue) {
    notes.push(`matched on ${catalogue.source} by ${catalogue.how}` +
      (catalogue.matchScore < 1 ? ` (${Math.round(catalogue.matchScore * 100)}% similar)` : ''));
    if (catalogue.title && track.title &&
        catalogue.title.toLowerCase() !== String(track.title).toLowerCase()) {
      notes.push(`matched record is "${catalogue.artist} – ${catalogue.title}"`);
    }
  }
  if (disagree) notes.push('the two sources disagree — check which one suits the track before trusting it');
  if (chosen?.from === 'analysis') notes.push('analysed from a 30-second preview, so it reflects that excerpt');
  $('matchnote').textContent = notes.join(' · ');
}

function decide(catalogue, analysis, prefer) {
  const cat = catalogue?.bpm != null ? { bpm: catalogue.bpm, from: 'catalogue' } : null;
  const ana = analysis?.tempo?.bpm != null ? { bpm: analysis.tempo.bpm, from: 'analysis' } : null;
  if (prefer === 'catalogue') return cat;
  if (prefer === 'analysis') return ana;
  return cat || ana;
}

async function runLookup(input) {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  $('go').disabled = true;
  $('result').classList.add('hidden');
  say($('msg'), 'looking it up…', 'work');

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'resolve', input });
  } catch (e) {
    $('go').disabled = false;
    say($('msg'), 'the extension background stopped responding — reload the extension', 'err');
    return;
  }

  if (!res || !res.ok) {
    $('go').disabled = false;
    setDots(res);
    say($('msg'), res?.error || 'lookup failed', 'err');
    return;
  }

  setDots(res);
  const state = { track: res.track, catalogue: res.catalogue, preview: res.preview, analysis: null };

  const needAnalysis =
    cfg.preferSource === 'analysis' ||
    cfg.alwaysAnalyse ||
    res.catalogue?.bpm == null;

  if (needAnalysis && res.preview) {
    say($('msg'), `analysing the ${res.preview.from} preview…`, 'work');
    try {
      state.analysis = await analysePreview(res.preview.url);
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'log', level: 'error', message: 'preview analysis failed', detail: e.message });
      say($('msg'), 'could not analyse the preview: ' + e.message, 'err');
    }
  }

  state.chosen = decide(state.catalogue, state.analysis, cfg.preferSource);

  if (!state.chosen) {
    $('go').disabled = false;
    say($('msg'),
      cfg.preferSource === 'catalogue'
        ? 'no catalogue BPM for this track — switch the source setting to analyse the audio'
        : 'no BPM available for this track',
      'err');
    return;
  }

  say($('msg'), '');
  render(state);
  await saveHistory(state);
  $('go').disabled = false;
}

$('go').addEventListener('click', () => {
  const v = $('link').value.trim();
  if (!v) { say($('msg'), 'paste a Spotify track link first', 'err'); return; }
  runLookup(v);
});

$('link').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('go').click();
});

$('from-tab').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (!/open\.spotify\.com\/(?:[a-z-]{2,8}\/)?track\//.test(url)) {
    say($('msg'), 'this tab is not a Spotify track page', 'err');
    return;
  }
  $('link').value = url;
  runLookup(url);
});

async function saveHistory(state) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({
    t: Date.now(),
    title: state.track.title,
    artist: state.track.artist,
    bpm: state.chosen.bpm,
    from: state.chosen.from,
    key: state.analysis?.key?.key || null,
    camelot: state.analysis?.key?.camelot || null,
    id: state.track.id,
  });
  await chrome.storage.local.set({ history: history.slice(0, 50) });
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const box = $('history');
  box.innerHTML = '';
  if (!history.length) {
    box.innerHTML = '<div class="empty">nothing looked up yet</div>';
    return;
  }
  for (const h of history) {
    const el = document.createElement('div');
    el.className = 'entry';

    const top = document.createElement('div');
    top.className = 'entry-top';
    const name = document.createElement('div');
    name.className = 'entry-name';
    name.textContent = `${h.artist} – ${h.title}`;
    name.title = name.textContent;
    const bpm = document.createElement('div');
    bpm.className = 'entry-bpm';
    bpm.textContent = h.bpm;
    top.append(name, bpm);

    const sub = document.createElement('div');
    sub.className = 'entry-sub';
    const bits = [h.from === 'catalogue' ? 'catalogue' : 'analysed'];
    if (h.camelot) bits.push(`${h.key} / ${h.camelot}`);
    bits.push(new Date(h.t).toLocaleString());
    sub.textContent = bits.join(' · ');

    el.append(top, sub);
    el.addEventListener('click', () => {
      $('link').value = `https://open.spotify.com/track/${h.id}`;
      document.querySelector('.tab[data-tab="lookup"]').click();
    });
    box.appendChild(el);
  }
}

$('clear-history').addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  renderHistory();
});

async function renderLogs() {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const box = $('logs');
  box.innerHTML = '';
  if (!logs.length) {
    box.innerHTML = '<div class="empty">no activity yet</div>';
    return;
  }
  for (const l of logs) {
    const el = document.createElement('div');
    el.className = 'logline ' + l.level;
    const t = document.createElement('span');
    t.className = 'lt';
    t.textContent = new Date(l.t).toLocaleTimeString() + '  ';
    const m = document.createElement('span');
    m.className = 'lm';
    m.textContent = l.message;
    el.append(t, m);
    if (l.detail) {
      const d = document.createElement('span');
      d.className = 'ld';
      d.textContent = l.detail;
      el.appendChild(d);
    }
    box.appendChild(el);
  }
}

$('clear-logs').addEventListener('click', async () => {
  await chrome.storage.local.set({ logs: [] });
  renderLogs();
});

async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  $('preferSource').value = s.preferSource;
  $('matchStrictness').value = s.matchStrictness;
  $('alwaysAnalyse').checked = !!s.alwaysAnalyse;
  $('spotifyClientId').value = s.spotifyClientId;
  $('spotifyClientSecret').value = s.spotifyClientSecret;
}

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    preferSource: $('preferSource').value,
    matchStrictness: $('matchStrictness').value,
    alwaysAnalyse: $('alwaysAnalyse').checked,
    spotifyClientId: $('spotifyClientId').value.trim(),
    spotifyClientSecret: $('spotifyClientSecret').value.trim(),
  });
  say($('save-msg'), 'saved', 'ok');
  setTimeout(() => say($('save-msg'), ''), 1500);
});

loadSettings();

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /open\.spotify\.com\/(?:[a-z-]{2,8}\/)?track\//.test(tab.url)) {
    $('link').value = tab.url;
  }
  $('link').focus();
})();
