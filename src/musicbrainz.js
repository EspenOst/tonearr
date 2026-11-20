// MusicBrainz client with rate limiting (max ~1 request/sec, as MB requires) and caching.
import { config, errorReason } from './config.js';

const BASE = 'https://musicbrainz.org/ws/2/';
const cache = new Map();
const TTL = 60 * 60 * 1000;
const MAX_CACHE = 1000;

// One request per 1.1 sec. Requests from users (high) always go before background jobs (low).
const queues = { high: [], low: [] };
let last = 0;
let pumping = false;

function throttle(priority = 'high') {
  return new Promise((resolve) => {
    queues[priority].push(resolve);
    pump();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queues.high.length || queues.low.length) {
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    (queues.high.shift() || queues.low.shift())();
  }
  pumping = false;
}

async function mb(pathAndQuery, { priority = 'high', useCache = true } = {}) {
  const key = pathAndQuery;
  const hit = useCache && cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle(priority);
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    let res;
    try {
      res = await fetch(BASE + pathAndQuery + sep + 'fmt=json', {
        headers: { 'User-Agent': config.mbUserAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      const reason = errorReason(e);
      console.error(`[musicbrainz] ${pathAndQuery.split('?')[0]}: ${reason}`);
      throw new Error(`Cannot reach MusicBrainz (${reason}) – check that the server has internet access and working DNS`);
    }
    if (res.status === 503 || res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (res.status === 404) return null;
    if (res.status === 403) throw new Error('MusicBrainz refused the request (403). Set a User-Agent with contact info under Settings, or the IP address may be blocked for too many requests');
    if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
    const v = await res.json();
    if (useCache) {
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, { t: Date.now(), v });
    }
    return v;
  }
  throw new Error('MusicBrainz is busy – try again shortly');
}

const year = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);
const credit = (ac = []) => ac.map((c) => c.name + (c.joinphrase || '')).join('') || '';
const mainArtist = (ac = []) => (ac[0]?.artist ? { mbid: ac[0].artist.id, name: ac[0].artist.name } : null);

// "Various Artists" (compilations) can't be requested: Lidarr would add it as one huge artist,
// so it is hidden from search and blocked everywhere. Besides MusicBrainz' official special artist,
// there are many other entries named like it ("Various Artists Genève", "The Various Artists", ...),
// so any name containing the phrase is blocked as well. "[unknown]" (unknown artist) is blocked the same way.
export const VARIOUS_ARTISTS = '89ad4ac3-39f7-470e-963a-56509c546377';
export const UNKNOWN_ARTIST = '125ec42a-7229-4250-afc5-e057484327fe';
const BLOCKED_IDS = new Set([VARIOUS_ARTISTS, UNKNOWN_ARTIST]);
export const isBlockedArtist = (mbid, name) =>
  BLOCKED_IDS.has(String(mbid || '').toLowerCase()) ||
  /\bvarious\s+artists?\b/i.test(name || '') ||
  /^\s*\[unknown\]\s*$/i.test(name || '');
const hasBlockedArtist = (ac = []) => ac.some((c) => isBlockedArtist(c.artist?.id, c.artist?.name) || isBlockedArtist(null, c.name));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Lucene escaping for the search string
const esc = (q) => q.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');

export function typeLabel(primary, secondary = []) {
  if (secondary?.length) return secondary[0]; // Compilation, Live, Soundtrack, Remix ...
  return primary || 'Other';
}

export async function searchArtists(q) {
  const data = await mb(`artist?query=${encodeURIComponent(esc(q))}&limit=20`);
  return (data?.artists || []).filter((a) => !isBlockedArtist(a.id, a.name)).map((a) => ({
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation || '',
    type: a.type || '',
    country: a.country || a.area?.name || '',
    score: a.score,
    begin: year(a['life-span']?.begin),
    end: year(a['life-span']?.end),
  }));
}

function mapReleaseGroup(rg) {
  return {
    mbid: rg.id,
    title: rg.title,
    primaryType: rg['primary-type'] || 'Other',
    secondaryTypes: rg['secondary-types'] || [],
    type: typeLabel(rg['primary-type'], rg['secondary-types']),
    year: year(rg['first-release-date']),
    date: rg['first-release-date'] || '',
    artistCredit: credit(rg['artist-credit']),
    artist: mainArtist(rg['artist-credit']),
  };
}

// Matches with equal score are sorted by number of releases – the original usually has the most
const byScoreThenPopularity = (a, b) => (b.score || 0) - (a.score || 0) || b.popularity - a.popularity;

export async function searchAlbums(q) {
  const data = await mb(`release-group?query=${encodeURIComponent(esc(q))}&limit=40`);
  return (data?.['release-groups'] || [])
    .filter((rg) => !hasBlockedArtist(rg['artist-credit']))
    .map((rg) => ({ ...mapReleaseGroup(rg), score: rg.score, popularity: rg.count || rg.releases?.length || 0 }))
    .sort(byScoreThenPopularity)
    .slice(0, 25);
}

// Pick the "best" release group for a recording: studio album > EP > single, official, earliest.
// Various Artists compilations are skipped; if that is all there is, the song has no album to request.
function bestReleaseGroup(releases = []) {
  releases = releases.filter((rel) => !hasBlockedArtist(rel['artist-credit']));
  const rank = (rel) => {
    const rg = rel['release-group'] || {};
    const pt = rg['primary-type'];
    const sec = rg['secondary-types'] || [];
    let s = pt === 'Album' ? 0 : pt === 'EP' ? 1 : pt === 'Single' ? 2 : 3;
    if (sec.length) s += 4;
    if (rel.status && rel.status !== 'Official') s += 8;
    return s;
  };
  const sorted = [...releases].filter((r) => r['release-group']).sort((a, b) => rank(a) - rank(b) || String(a.date || '9999').localeCompare(String(b.date || '9999')));
  return sorted[0] || null;
}

export async function searchSongs(q) {
  const data = await mb(`recording?query=${encodeURIComponent(esc(q))}&limit=60`);
  const seen = new Set();
  const out = [];
  const recordings = (data?.recordings || [])
    .map((r) => ({ ...r, popularity: r.releases?.length || 0 }))
    .sort(byScoreThenPopularity);
  for (const r of recordings) {
    if (out.length >= 25) break;
    if (hasBlockedArtist(r['artist-credit'])) continue;
    const best = bestReleaseGroup(r.releases);
    const artist = mainArtist(r['artist-credit']);
    const key = (artist?.mbid || '') + '|' + r.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rg = best?.['release-group'];
    out.push({
      mbid: r.id,
      title: r.title,
      length: r.length || null,
      artistCredit: credit(r['artist-credit']),
      artist,
      album: rg
        ? { mbid: rg.id, title: rg.title || best.title, type: typeLabel(rg['primary-type'], rg['secondary-types']), year: year(best.date) }
        : null,
    });
  }
  return out;
}

export async function getArtist(mbid) {
  const a = await mb(`artist/${encodeURIComponent(mbid)}?inc=genres+url-rels`);
  if (!a) return null;
  return {
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation || '',
    type: a.type || '',
    country: a.country || a.area?.name || '',
    begin: year(a['life-span']?.begin),
    end: year(a['life-span']?.end),
    genres: (a.genres || []).sort((x, y) => y.count - x.count).slice(0, 5).map((g) => g.name),
  };
}

/** All release groups (albums, EPs, singles) for an artist. */
export async function getArtistReleaseGroups(mbid) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const data = await mb(`release-group?artist=${encodeURIComponent(mbid)}&type=album|ep|single&limit=100&offset=${offset}`);
    const list = data?.['release-groups'] || [];
    all.push(...list);
    offset += list.length;
    if (!list.length || offset >= (data['release-group-count'] || 0)) break;
  }
  return all.map(mapReleaseGroup).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export async function getReleaseGroup(mbid) {
  const rg = await mb(`release-group/${encodeURIComponent(mbid)}?inc=artist-credits`);
  return rg ? mapReleaseGroup(rg) : null;
}

/**
 * An artist's official studio albums, with the number of releases (editions, reissues) in each –
 * a decent measure of how well-known an album is. Runs at low priority.
 * `total` is how many matched; above 100 the list is an arbitrary selection.
 */
export async function artistStudioAlbums(mbid) {
  if (!UUID.test(mbid)) return { total: 0, albums: [] };
  const query = `arid:${mbid} AND primarytype:album AND status:official AND NOT secondarytype:*`;
  const data = await mb(`release-group?query=${encodeURIComponent(query)}&limit=100`, { priority: 'low', useCache: false });
  const albums = (data?.['release-groups'] || [])
    .filter((rg) => !hasBlockedArtist(rg['artist-credit']))
    .map((rg) => ({ ...mapReleaseGroup(rg), releases: rg.count || 0 }));
  return { total: data?.count || 0, albums };
}

/**
 * Looks up many release groups (type, date, main artist) with one search request per 50 IDs.
 * Runs at low priority. Returns Map<releaseGroupId, release group>; unknown IDs and
 * Various Artists releases are left out.
 */
export async function lookupReleaseGroups(ids) {
  ids = [...new Set(ids.map((id) => String(id).toLowerCase()))].filter((id) => UUID.test(id));
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const query = batch.map((id) => 'rgid:' + id).join(' OR ');
    const data = await mb(`release-group?query=${encodeURIComponent(query)}&limit=100`, { priority: 'low' });
    for (const rg of data?.['release-groups'] || []) {
      if (batch.includes(rg.id) && !hasBlockedArtist(rg['artist-credit'])) out.set(rg.id, mapReleaseGroup(rg));
    }
  }
  return out;
}

/**
 * Looks up the release group for many release IDs in a single search request (max 100).
 * Runs at low priority so user searches are never stuck behind it.
 * Returns Map<releaseId, releaseGroupId>; IDs MusicBrainz doesn't know are left out.
 */
export async function releaseGroupsForReleases(ids) {
  const query = ids.map((id) => 'reid:' + id).join(' OR ');
  const data = await mb(`release?query=${encodeURIComponent(query)}&limit=100`, { priority: 'low', useCache: false });
  const out = new Map();
  for (const r of data?.releases || []) {
    if (r.id && r['release-group']?.id) out.set(r.id.toLowerCase(), r['release-group'].id.toLowerCase());
  }
  return out;
}
