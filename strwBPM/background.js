const DEFAULTS = {
  matchStrictness: 'balanced',
  alwaysAnalyse: true,
  preferSource: 'auto',
  spotifyClientId: '',
  spotifyClientSecret: '',
};

async function config() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

const MAX_LOG = 300;

async function log(level, message, detail = '') {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.unshift({ t: Date.now(), level, message, detail: String(detail).slice(0, 400) });
  await chrome.storage.local.set({ logs: logs.slice(0, MAX_LOG) });
}

export function parseSpotifyLink(input) {
  if (!input) return null;
  const s = input.trim();

  let m = s.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  if (m) return { id: m[1] };

  if (/^[A-Za-z0-9]{22}$/.test(s)) return { id: s };

  m = s.match(/open\.spotify\.com\/(?:[a-z-]{2,8}\/)?track\/([A-Za-z0-9]{22})/);
  if (m) return { id: m[1] };

  if (/spotify\.link|link\.tospotify\.com/.test(s)) return { shortlink: s };

  m = s.match(/open\.spotify\.com\/(?:[a-z-]{2,8}\/)?(album|playlist|artist|episode|show)\//);
  if (m) return { wrongType: m[1] };

  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

export function meta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

function jsonScript(html, id) {
  const re = new RegExp(`<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const m = html.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function findEntity(root) {
  const seen = new Set();
  const queue = [root];
  let fallback = null;

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    if (typeof node.name === 'string' && Array.isArray(node.artists) && node.artists.length) {
      return node;
    }
    if (!fallback && typeof node.title === 'string' && typeof node.subtitle === 'string') {
      fallback = node;
    }

    if (Array.isArray(node)) queue.push(...node);
    else for (const k of Object.keys(node)) queue.push(node[k]);
  }
  return fallback;
}

function biggestImage(ent) {
  const pools = [ent?.coverArt?.sources, ent?.visualIdentity?.image, ent?.images, ent?.album?.images];
  for (const pool of pools) {
    if (Array.isArray(pool) && pool.length) {
      const sorted = [...pool].sort((a, b) => (b.width || 0) - (a.width || 0));
      const pick = sorted[0];
      if (pick?.url) return pick.url;
    }
  }
  return null;
}

function previewUrl(ent) {
  if (typeof ent?.audioPreview?.url === 'string') return ent.audioPreview.url;
  if (Array.isArray(ent?.audioPreview) && ent.audioPreview[0]?.url) return ent.audioPreview[0].url;
  if (typeof ent?.preview_url === 'string') return ent.preview_url;
  return null;
}

export function entityToTrack(ent, id) {
  if (!ent) return null;
  const title = ent.name || ent.title;
  if (!title) return null;

  let artist = '';
  if (Array.isArray(ent.artists) && ent.artists.length) {
    artist = ent.artists.map((a) => a?.name || a?.profile?.name || '').filter(Boolean).join(', ');
  }
  if (!artist && typeof ent.subtitle === 'string') artist = ent.subtitle;

  const durationMs = ent.duration ?? ent.durationMs ?? ent.duration_ms ?? null;

  return {
    id,
    title,
    artist,
    durationMs: typeof durationMs === 'number' && durationMs > 0 ? durationMs : null,
    artwork: biggestImage(ent),
    isrc: ent.isrc || ent.externalIds?.isrc || null,
    spotifyPreview: previewUrl(ent),
    source: 'spotify embed',
  };
}

async function metadataFromEmbed(id) {
  const res = await fetch(`https://open.spotify.com/embed/track/${id}`, {
    credentials: 'omit',
    headers: { 'Accept-Language': 'en' },
  });
  if (!res.ok) throw new Error(`embed page returned ${res.status}`);
  const html = await res.text();

  let data = jsonScript(html, '__NEXT_DATA__');
  if (!data) {
    const m = html.match(/<script[^>]*>\s*(\{[\s\S]{200,}?\})\s*<\/script>/);
    if (m) { try { data = JSON.parse(m[1]); } catch {} }
  }
  if (!data) throw new Error(`no JSON island in the embed page (${html.length} bytes)`);

  const track = entityToTrack(findEntity(data), id);
  if (!track) throw new Error('embed JSON had no recognisable track object');
  return track;
}

async function metadataFromOembed(id) {
  const target = `https://open.spotify.com/track/${id}`;
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(target)}`, {
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`oembed returned ${res.status}`);
  const j = await res.json();
  if (!j?.title) throw new Error('oembed returned no title');

  let title = j.title, artist = '';
  const dash = title.match(/^(.*?)\s+[-\u2013]\s+(.*)$/);
  if (dash) { artist = dash[1].trim(); title = dash[2].trim(); }

  return {
    id, title, artist,
    durationMs: null,
    artwork: j.thumbnail_url || null,
    isrc: null,
    spotifyPreview: null,
    source: 'spotify oembed',
  };
}

async function metadataFromOgTags(id) {
  const res = await fetch(`https://open.spotify.com/track/${id}`, {
    credentials: 'omit',
    headers: { 'Accept-Language': 'en' },
  });
  if (!res.ok) throw new Error(`track page returned ${res.status}`);
  const html = await res.text();

  const title = meta(html, 'og:title');
  if (!title) throw new Error(`no og:title in ${html.length} bytes of markup`);

  let artist = meta(html, 'music:musician_description') || meta(html, 'twitter:audio:artist_name');
  if (!artist) {
    const desc = meta(html, 'og:description') || '';
    const parts = desc.split('\u00b7').map((p) => p.trim()).filter(Boolean);
    artist = parts.find((p) => p !== title && !/^\d{4}$/.test(p)) || '';
  }
  const durSec = parseInt(meta(html, 'music:duration') || '0', 10) || null;

  return {
    id, title, artist,
    durationMs: durSec ? durSec * 1000 : null,
    artwork: meta(html, 'og:image'),
    isrc: null,
    spotifyPreview: null,
    source: 'spotify page',
  };
}

async function metadataWithoutToken(id) {
  const strategies = [
    ['embed page', metadataFromEmbed],
    ['oembed', metadataFromOembed],
    ['page tags', metadataFromOgTags],
  ];
  const problems = [];

  for (const [name, fn] of strategies) {
    try {
      const m = await fn(id);
      if (m?.title) {
        await log('info', `metadata via ${name}`,
          `${m.artist || 'unknown artist'} - ${m.title}${m.spotifyPreview ? ' (+preview)' : ''}`);
        return m;
      }
      problems.push(`${name}: no title`);
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
    }
  }

  await log('error', 'every metadata route failed', problems.join(' | '));
  throw new Error(`could not read the track — ${problems.join('; ')}`);
}

let tokenCache = { token: null, expires: 0 };

async function clientCredentialsToken(cfg) {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  const basic = btoa(`${cfg.spotifyClientId}:${cfg.spotifyClientSecret}`);
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token request returned ${res.status}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function metadataFromApi(id, cfg) {
  const token = await clientCredentialsToken(cfg);
  const res = await fetch(`https://api.spotify.com/v1/tracks/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify /v1/tracks returned ${res.status}`);
  const t = await res.json();
  return {
    id,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    durationMs: t.duration_ms ?? null,
    artwork: t.album?.images?.[0]?.url || null,
    isrc: t.external_ids?.isrc || null,
    album: t.album?.name || null,
    releaseDate: t.album?.release_date || null,
    spotifyPreview: t.preview_url || null,
    source: 'spotify api',
  };
}

async function getSpotifyMetadata(id) {
  const cfg = await config();
  if (cfg.spotifyClientId && cfg.spotifyClientSecret) {
    try {
      const m = await metadataFromApi(id, cfg);
      await log('info', 'metadata via Spotify API', `${m.artist} - ${m.title}${m.isrc ? ' (ISRC ' + m.isrc + ')' : ''}`);
      return m;
    } catch (e) {
      await log('warn', 'Spotify API metadata failed, falling back to the public page', e.message);
    }
  }
  return metadataWithoutToken(id);
}

export function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\((feat|ft|with)[^)]*\)/g, '')
    .replace(/-\s*[^-]*(remaster(ed)?|radio edit|single version|album version|mono version|stereo version)[^-]*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function similarity(a, b) {
  const A = new Set(normalise(a).split(' ').filter(Boolean));
  const B = new Set(normalise(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  return hits / Math.max(A.size, B.size);
}

const THRESHOLDS = { strict: 0.85, balanced: 0.6, loose: 0.35 };

export function scoreCandidate(track, cand) {
  const titleSim = similarity(track.title, cand.title);
  const artistSim = similarity(track.artist, cand.artist);
  let score = titleSim * 0.55 + artistSim * 0.45;

  if (track.durationMs && cand.durationMs) {
    const diff = Math.abs(track.durationMs - cand.durationMs) / 1000;
    if (diff <= 2) score += 0.15;
    else if (diff <= 5) score += 0.05;
    else if (diff > 15) score -= 0.35;
  }

  if (artistSim === 0) score *= 0.5;
  if (titleSim === 0) score *= 0.5;

  return { score: Math.max(0, Math.min(1, score)), titleSim, artistSim };
}

async function deezerByIsrc(isrc) {
  const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
  if (!res.ok) return null;
  const j = await res.json();
  if (!j || j.error || !j.id) return null;
  return j;
}

async function deezerSearch(track) {
  const q = `artist:"${(track.artist || '').replace(/"/g, '')}" track:"${(track.title || '').replace(/"/g, '')}"`;
  const queries = [q, `${track.artist} ${track.title}`];
  for (const query of queries) {
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=10`);
    if (!res.ok) continue;
    const j = await res.json();
    if (j?.data?.length) return j.data;
  }
  return [];
}

function deezerToCandidate(d) {
  return {
    title: d.title_short || d.title,
    artist: d.artist?.name || '',
    durationMs: d.duration ? d.duration * 1000 : null,
    preview: d.preview || null,
    id: d.id,
    link: d.link,
  };
}

async function deezerDetail(id) {
  const res = await fetch(`https://api.deezer.com/track/${id}`);
  if (!res.ok) return null;
  const j = await res.json();
  return j && !j.error ? j : null;
}

async function findOnDeezer(track, strictness) {
  const threshold = THRESHOLDS[strictness] ?? THRESHOLDS.balanced;

  if (track.isrc) {
    const exact = await deezerByIsrc(track.isrc);
    if (exact) {
      await log('info', 'Deezer matched by ISRC', track.isrc);
      return { detail: exact, match: { score: 1, how: 'ISRC (exact recording)' } };
    }
    await log('warn', 'no Deezer record for that ISRC, falling back to search', track.isrc);
  }

  const results = await deezerSearch(track);
  if (!results.length) return null;

  let best = null;
  for (const r of results) {
    const cand = deezerToCandidate(r);
    const sc = scoreCandidate(track, cand);
    if (!best || sc.score > best.sc.score) best = { r, cand, sc };
  }
  if (!best || best.sc.score < threshold) {
    await log('warn', 'no Deezer match above threshold',
      `best ${best ? best.sc.score.toFixed(2) : 'n/a'} vs ${threshold}`);
    return null;
  }

  const detail = await deezerDetail(best.r.id);
  await log('info', 'Deezer matched by search', `${best.cand.artist} - ${best.cand.title} (${best.sc.score.toFixed(2)})`);
  return {
    detail: detail || best.r,
    match: { score: best.sc.score, how: 'title, artist and duration' },
  };
}

async function findOnItunes(track, strictness) {
  const threshold = THRESHOLDS[strictness] ?? THRESHOLDS.balanced;
  const term = `${track.artist} ${track.title}`;
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=10`
  );
  if (!res.ok) return null;
  const j = await res.json();
  if (!j?.results?.length) return null;

  let best = null;
  for (const r of j.results) {
    const cand = {
      title: r.trackName,
      artist: r.artistName,
      durationMs: r.trackTimeMillis || null,
    };
    const sc = scoreCandidate(track, cand);
    if (!best || sc.score > best.sc.score) best = { r, cand, sc };
  }
  if (!best || best.sc.score < threshold || !best.r.previewUrl) return null;

  await log('info', 'iTunes preview matched', `${best.cand.artist} - ${best.cand.title} (${best.sc.score.toFixed(2)})`);
  return {
    preview: best.r.previewUrl,
    match: { score: best.sc.score, how: 'title, artist and duration' },
    artwork: best.r.artworkUrl100 ? best.r.artworkUrl100.replace('100x100', '600x600') : null,
  };
}

async function resolve(input) {
  const parsed = parseSpotifyLink(input);
  if (!parsed) return { ok: false, error: "that doesn't look like a Spotify track link" };
  if (parsed.shortlink) {
    return { ok: false, error: 'open the short link once in a tab, then paste the full open.spotify.com URL' };
  }
  if (parsed.wrongType) {
    return { ok: false, error: `that's ${parsed.wrongType === 'album' ? 'an' : 'a'} ${parsed.wrongType} link — paste a single track` };
  }

  const cfg = await config();
  let track;
  try {
    track = await getSpotifyMetadata(parsed.id);
  } catch (e) {
    await log('error', 'could not read the track', e.message);
    return { ok: false, error: e.message };
  }

  const out = {
    ok: true,
    track,
    catalogue: null,
    preview: null,
  };

  if (track.spotifyPreview) {
    out.preview = { url: track.spotifyPreview, from: 'Spotify', exact: true };
  }

  try {
    const dz = await findOnDeezer(track, cfg.matchStrictness);
    if (dz) {
      const bpm = Number(dz.detail.bpm) || 0;
      out.catalogue = {
        bpm: bpm > 0 ? Math.round(bpm * 10) / 10 : null,
        source: 'Deezer',
        link: dz.detail.link || null,
        matchScore: dz.match.score,
        how: dz.match.how,
        title: dz.detail.title_short || dz.detail.title,
        artist: dz.detail.artist?.name || '',
      };
      if (!out.preview && dz.detail.preview) {
        out.preview = { url: dz.detail.preview, from: 'Deezer', exact: dz.match.score === 1 };
      }
      if (bpm <= 0) await log('warn', 'Deezer has the track but no BPM for it', out.catalogue.title);
    }
  } catch (e) {
    await log('error', 'Deezer lookup failed', e.message);
  }

  if (!out.preview) {
    try {
      const it = await findOnItunes(track, cfg.matchStrictness);
      if (it) {
        out.preview = { url: it.preview, from: 'iTunes', exact: false };
        if (!track.artwork && it.artwork) track.artwork = it.artwork;
      }
    } catch (e) {
      await log('error', 'iTunes lookup failed', e.message);
    }
  }

  if (!out.catalogue?.bpm && !out.preview) {
    out.ok = false;
    out.error = 'found the track on Spotify but no catalogue BPM and no preview to analyse';
    await log('error', 'nothing to report', `${track.artist} - ${track.title}`);
  }

  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'resolve') {
    resolve(msg.input).then(sendResponse).catch((e) =>
      sendResponse({ ok: false, error: e?.message || String(e) })
    );
    return true;
  }
  if (msg?.type === 'log') {
    log(msg.level || 'info', msg.message, msg.detail).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
