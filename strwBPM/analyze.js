function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;      im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function downsample(samples, srIn, srOut) {
  if (srOut >= srIn) return { data: samples, sr: srIn };
  const ratio = srIn / srOut;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return { data: out, sr: srOut };
}

const FRAME = 1024;
const HOP = 128;
const ANALYSIS_SR = 11025;

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

function spectrogram(x, frame, hop) {
  const win = hann(frame);
  const nFrames = Math.max(0, 1 + Math.floor((x.length - frame) / hop));
  const bins = frame / 2 + 1;
  const out = [];
  const re = new Float64Array(frame);
  const im = new Float64Array(frame);

  for (let f = 0; f < nFrames; f++) {
    const off = f * hop;
    for (let i = 0; i < frame; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fftRadix2(re, im);
    const mag = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
    }
    out.push(mag);
  }
  return out;
}

function onsetEnvelope(spec) {
  const n = spec.length;
  if (n < 2) return new Float32Array(0);
  const bins = spec[0].length;
  const flux = new Float32Array(n);

  for (let f = 1; f < n; f++) {
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      const d = spec[f][k] - spec[f - 1][k];
      if (d > 0) sum += d;
    }
    flux[f] = sum;
  }

  const W = 16;
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - W), b = Math.min(n, f + W + 1);
    let m = 0;
    for (let i = a; i < b; i++) m += flux[i];
    m /= b - a;
    env[f] = Math.max(0, flux[f] - m);
  }
  return env;
}

function autocorrelate(env, maxLag) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n || 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - mean;

  const ac = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    const lim = n - lag;
    for (let i = 0; i < lim; i++) s += x[i] * x[i + lag];
    ac[lag] = lim > 0 ? s / lim : 0;
  }
  const norm = ac[0] || 1;
  for (let lag = 0; lag <= maxLag; lag++) ac[lag] /= norm;
  return ac;
}

function acAt(ac, lag) {
  if (lag < 0 || lag >= ac.length - 1) return 0;
  const i = Math.floor(lag);
  const t = lag - i;
  return ac[i] * (1 - t) + ac[i + 1] * t;
}

const MIN_BPM = 55;
const MAX_BPM = 215;

function tempoPrior(bpm, center = 124, spread = 0.95) {
  const z = Math.log2(bpm / center) / spread;
  return Math.exp(-0.5 * z * z);
}

function combScore(ac, lagFrames) {
  let s = 0, w = 0;
  for (let m = 1; m <= 4; m++) {
    const weight = 1 / m;
    s += weight * acAt(ac, lagFrames * m);
    w += weight;
  }
  return s / w;
}

const SUBHARMONIC_CUTOFF = 0.55;

function gridEnergy(env, period) {
  const at = (i) => {
    let m = 0;
    for (let d = -1; d <= 1; d++) {
      const j = Math.round(i) + d;
      if (j >= 0 && j < env.length && env[j] > m) m = env[j];
    }
    return m;
  };

  let bestOn = -1, bestPhase = 0;
  for (let ph = 0; ph < Math.ceil(period); ph++) {
    let s = 0, c = 0;
    for (let x = ph; x < env.length; x += period) { s += at(x); c++; }
    s /= c || 1;
    if (s > bestOn) { bestOn = s; bestPhase = ph; }
  }

  let mid = 0, c2 = 0;
  for (let x = bestPhase + period / 2; x < env.length; x += period) { mid += at(x); c2++; }
  mid /= c2 || 1;

  return { on: bestOn, mid, ratio: mid / (bestOn || 1), phase: bestPhase };
}

const METRICAL_RATIOS = [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3];

const LEVEL_RATIOS = [1 / 2, 1, 2];

function pickMetricalLevel(env, fps, anchor) {
  const family = [];
  const evaluate = (bpm) => {
    if (bpm < MIN_BPM || bpm > MAX_BPM) return null;
    const g = { bpm, ...gridEnergy(env, (60 * fps) / bpm) };
    family.push(g);
    return g;
  };

  const here = evaluate(anchor);
  if (!here) return { bpm: anchor, family, gated: false, moved: 'none' };

  if (here.ratio >= SUBHARMONIC_CUTOFF) {
    const up = evaluate(anchor * 2);
    if (up && up.ratio < SUBHARMONIC_CUTOFF) {
      return { bpm: up.bpm, family, gated: true, moved: 'up' };
    }
    return { bpm: anchor, family, gated: false, moved: 'none' };
  }

  let cur = here;
  for (let step = 0; step < 2; step++) {
    const down = evaluate(cur.bpm / 2);
    if (down && down.ratio < SUBHARMONIC_CUTOFF) cur = down;
    else break;
  }
  return { bpm: cur.bpm, family, gated: cur !== here, moved: cur === here ? 'none' : 'down' };
}

function refineTempo(env, fps, bpm) {
  let best = { bpm, on: -1 };
  for (let b = bpm * 0.97; b <= bpm * 1.03; b += 0.05) {
    const g = gridEnergy(env, (60 * fps) / b);
    if (g.on > best.on) best = { bpm: b, on: g.on };
  }
  return Math.round(best.bpm * 10) / 10;
}

function analyzeTempo(samples, sampleRate) {
  const ds = downsample(samples, sampleRate, ANALYSIS_SR);
  const fps = ds.sr / HOP;
  const spec = spectrogram(ds.data, FRAME, HOP);
  const env = onsetEnvelope(spec);

  if (env.length < fps * 4) {
    return { bpm: null, confidence: 0, alternates: [], reason: 'clip too short to analyse' };
  }

  const maxLag = Math.min(Math.floor(env.length / 2), Math.ceil((60 * fps) / MIN_BPM) * 4 + 2);
  const ac = autocorrelate(env, maxLag);

  const cands = [];
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.1) {
    const lag = (60 * fps) / bpm;
    if (lag * 4 > maxLag) continue;
    cands.push({ bpm: Math.round(bpm * 10) / 10, score: combScore(ac, lag) * tempoPrior(bpm) });
  }
  if (!cands.length) return { bpm: null, confidence: 0, alternates: [], reason: 'no tempo candidates' };
  cands.sort((a, b) => b.score - a.score);
  const anchor = cands[0];

  const level = pickMetricalLevel(env, fps, anchor.bpm);
  const bpm = refineTempo(env, fps, level.bpm);

  const unrelated = cands.find((c) => {
    for (const r of METRICAL_RATIOS) {
      if (Math.abs(c.bpm / (anchor.bpm * r) - 1) < 0.04) return false;
    }
    return true;
  });
  const margin = unrelated
    ? (anchor.score - unrelated.score) / (Math.abs(anchor.score) + 1e-9)
    : 1;
  const chosen = level.family.find((f) => Math.abs(f.bpm - level.bpm) < 1e-6);
  const gridClarity = chosen ? Math.max(0, 1 - chosen.ratio / SUBHARMONIC_CUTOFF) : 0.3;
  const confidence = Math.max(0, Math.min(1, 0.6 * Math.max(0, margin) + 0.4 * gridClarity));

  const alternates = [bpm / 2, bpm * 2, (bpm * 2) / 3, (bpm * 3) / 2]
    .map((b) => Math.round(b * 10) / 10)
    .filter((b) => b >= 40 && b <= 260);

  return {
    bpm,
    confidence: Math.round(confidence * 100) / 100,
    alternates,
    anchor: anchor.bpm,
    levelGated: level.gated,
  };
}

const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) || 1);
}

function analyzeKey(samples, sampleRate) {
  const ds = downsample(samples, sampleRate, 11025);
  const spec = spectrogram(ds.data, 4096, 2048);
  if (!spec.length) return null;

  const chroma = new Float64Array(12);
  const binHz = ds.sr / 4096;
  const loBin = Math.max(2, Math.floor(65 / binHz));
  const hiBin = Math.min(spec[0].length - 2, Math.floor(2100 / binHz));

  for (const frame of spec) {
    let mean = 0;
    for (let k = loBin; k <= hiBin; k++) mean += frame[k];
    mean /= Math.max(1, hiBin - loBin + 1);

    for (let k = loBin; k <= hiBin; k++) {
      const v = frame[k];
      if (v <= mean) continue;
      if (v < frame[k - 1] || v < frame[k + 1]) continue;

      const a = frame[k - 1], b = v, c = frame[k + 1];
      const denom = a - 2 * b + c;
      const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      const hz = (k + Math.max(-0.5, Math.min(0.5, delta))) * binHz;
      if (hz < 60) continue;

      const midi = 69 + 12 * Math.log2(hz / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += (v - mean) * (v - mean);
    }
  }

  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (total <= 0) return null;
  for (let i = 0; i < 12; i++) chroma[i] /= total;

  let best = null;
  for (let root = 0; root < 12; root++) {
    const rotated = new Float64Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(root + i) % 12];
    const maj = pearson(rotated, KRUMHANSL_MAJOR);
    const min = pearson(rotated, KRUMHANSL_MINOR);
    if (!best || maj > best.score) best = { root, mode: 'major', score: maj };
    if (min > best.score) best = { root, mode: 'minor', score: min };
  }

  return {
    key: NOTE_NAMES[best.root] + (best.mode === 'minor' ? 'm' : ''),
    camelot: best.mode === 'minor' ? CAMELOT_MINOR[best.root] : CAMELOT_MAJOR[best.root],
    confidence: Math.round(Math.max(0, best.score) * 100) / 100,
  };
}

function analyzeBuffer(samples, sampleRate) {
  return {
    tempo: analyzeTempo(samples, sampleRate),
    key: analyzeKey(samples, sampleRate),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { analyzeBuffer, analyzeTempo, analyzeKey, downsample, onsetEnvelope, spectrogram };
}
