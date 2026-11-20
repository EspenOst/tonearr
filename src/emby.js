// Emby: sign-in with an Emby user + index of the music library.
import { config, errorReason } from './config.js';
import * as releaseGroups from './releasegroups.js';

const client = () => `Emby Client="${config.appName || 'Tonearr'}", Device="Tonearr Server", DeviceId="tonearr-server", Version="${config.version}"`;

export const norm = (s = '') =>
  s.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();

async function embyFetch(pathAndQuery, { method = 'GET', body, token, baseUrl } = {}) {
  const headers = { 'X-Emby-Authorization': client(), Accept: 'application/json' };
  if (token) headers['X-Emby-Token'] = token;
  else if (config.embyApiKey) headers['X-Emby-Token'] = config.embyApiKey;
  if (body) headers['Content-Type'] = 'application/json';
  if (!(baseUrl || config.embyUrl)) throw new Error('Emby is not set up');
  const res = await fetch((baseUrl || config.embyUrl) + pathAndQuery, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const err = new Error(`Emby ${method} ${pathAndQuery.split('?')[0]} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Signs in against Emby. Returns { id, name, isAdmin }, null for wrong credentials, or throws.
 * baseUrl is used during first-time setup, before an Emby address has been saved.
 */
export async function authenticate(username, password, baseUrl = config.embyUrl) {
  const res = await fetch(baseUrl + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'X-Emby-Authorization': client(), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Emby responded ${res.status}`);
  const data = await res.json();
  const user = data.User;
  // We don't need the user's Emby token afterwards; log it out so no sessions are left hanging.
  embyFetch('/Sessions/Logout', { method: 'POST', token: data.AccessToken, baseUrl }).catch(() => {});
  if (user?.Policy?.IsDisabled) return null;
  return { id: user.Id, name: user.Name, isAdmin: !!user.Policy?.IsAdministrator };
}

export async function systemInfo() {
  return embyFetch('/System/Info');
}

/** Tests a (possibly unsaved) address + API key. Throws descriptive errors. */
export async function testConnection(url, apiKey) {
  let info;
  try {
    info = await embyFetch('/System/Info', { baseUrl: url, token: apiKey });
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw new Error('Emby rejected the API key');
    if (e.status) throw new Error(`Emby responded ${e.status} – is the address correct?`);
    throw new Error(`Cannot reach ${url} (${errorReason(e)}) – check the address and port`);
  }
  const albums = await embyFetch('/Items?IncludeItemTypes=MusicAlbum&Recursive=true&Limit=0', { baseUrl: url, token: apiKey }).catch(() => null);
  return { name: info.ServerName, version: info.Version, albums: albums?.TotalRecordCount ?? null };
}

export function resetIndex() {
  index = null;
  indexBuiltAt = 0;
}

// ---------- Library index ----------
let index = null;
let indexBuiltAt = 0;
let building = null;

async function buildIndex() {
  const fields = 'ProviderIds,ChildCount';
  const [albums, artists] = await Promise.all([
    embyFetch(`/Items?IncludeItemTypes=MusicAlbum&Recursive=true&Fields=${fields}`),
    embyFetch(`/Items?IncludeItemTypes=MusicArtist&Recursive=true&Fields=ProviderIds`),
  ]);
  const idx = {
    releaseGroups: new Map(), // MB release-group id -> album info
    releases: new Map(), // MB release id -> album info
    names: new Map(), // "artist|album" -> album info
    artists: new Map(), // MB artist id -> { embyId, name, mbid }
    artistNames: new Map(), // normalized name -> { embyId, name, mbid }
    artistsByEmbyId: new Map(), // Emby item id -> { embyId, name, mbid }
    releaseOnly: [], // albums with a release ID but no release group ID: [{ releaseId, info }]
    albumsByArtist: new Map(), // normalized album artist name -> number of albums (artists only on guest tracks have none)
    albumCount: 0,
  };
  for (const a of albums?.Items || []) {
    const info = { embyId: a.Id, name: a.Name, artist: a.AlbumArtist || a.AlbumArtists?.[0]?.Name || '' };
    for (const n of new Set([info.artist, ...(a.AlbumArtists || []).map((x) => x.Name)].filter(Boolean).map(norm))) {
      idx.albumsByArtist.set(n, (idx.albumsByArtist.get(n) || 0) + 1);
    }
    const p = a.ProviderIds || {};
    if (p.MusicBrainzReleaseGroup) idx.releaseGroups.set(p.MusicBrainzReleaseGroup.toLowerCase(), info);
    if (p.MusicBrainzAlbum) idx.releases.set(p.MusicBrainzAlbum.toLowerCase(), info);
    if (p.MusicBrainzAlbum && !p.MusicBrainzReleaseGroup) idx.releaseOnly.push({ releaseId: p.MusicBrainzAlbum.toLowerCase(), info });
    // Name matching only as a fallback for albums without a MusicBrainz ID (avoids false matches on identical titles)
    if (!p.MusicBrainzReleaseGroup && !p.MusicBrainzAlbum) {
      for (const artistName of [info.artist, ...(a.AlbumArtists || []).map((x) => x.Name)]) {
        if (artistName) idx.names.set(norm(artistName) + '|' + norm(a.Name), info);
      }
    }
    idx.albumCount++;
  }
  for (const a of artists?.Items || []) {
    const p = a.ProviderIds || {};
    const info = { embyId: a.Id, name: a.Name, mbid: p.MusicBrainzArtist?.toLowerCase() || null };
    if (info.mbid) idx.artists.set(info.mbid, info);
    idx.artistNames.set(norm(a.Name), info);
    idx.artistsByEmbyId.set(a.Id, info);
  }
  releaseGroups.applyTo(idx);
  index = idx;
  indexBuiltAt = Date.now();
  console.log(`[emby] Index updated: ${idx.albumCount} albums, ${idx.artists.size} artists with MBID`);
  releaseGroups.resolveInBackground(() => index); // not awaited – runs in the background
  return idx;
}

export async function getIndex({ force = false } = {}) {
  // Sign-in only needs the address, but reading the library needs the API key
  if (!config.embyUrl || !config.embyApiKey) throw new Error('The Emby API key is not set up yet (Settings)');
  const fresh = index && Date.now() - indexBuiltAt < config.embyIndexTtlSec * 1000;
  if (fresh && !force) return index;
  if (!building) building = buildIndex().finally(() => { building = null; });
  try {
    return await building;
  } catch (e) {
    console.error('[emby] Could not build index:', e.message);
    if (index) return index; // use the previous version
    throw e;
  }
}

export function indexInfo() {
  return index
    ? { albums: index.albumCount, artists: index.artists.size, builtAt: new Date(indexBuiltAt).toISOString(), releaseLookup: releaseGroups.stats(index) }
    : null;
}

/** Is the album in Emby? Matches on release group, release IDs or artist + title. */
export function findAlbum(idx, { rgMbid, releaseIds = [], artistName, title }) {
  if (!idx) return null;
  if (rgMbid && idx.releaseGroups.has(rgMbid.toLowerCase())) return idx.releaseGroups.get(rgMbid.toLowerCase());
  for (const r of releaseIds) if (idx.releases.has(r.toLowerCase())) return idx.releases.get(r.toLowerCase());
  if (artistName && title) return idx.names.get(norm(artistName) + '|' + norm(title)) || null;
  return null;
}

export function findArtist(idx, { mbid, name }) {
  if (!idx) return null;
  if (mbid && idx.artists.has(mbid.toLowerCase())) return idx.artists.get(mbid.toLowerCase());
  if (name) return idx.artistNames.get(norm(name)) || null;
  return null;
}

// ---------- Listening history ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECENT_DAYS = 90;

/** The MusicBrainz artist of a track, album or artist item – the album artist first, so guests don't count. */
function artistOf(item, idx) {
  if (item.Type === 'MusicArtist') {
    const info = idx.artistsByEmbyId.get(item.Id);
    const mbid = info?.mbid || item.ProviderIds?.MusicBrainzArtist?.toLowerCase();
    return mbid ? { mbid, name: info?.name || item.Name } : null;
  }
  const p = item.ProviderIds || {};
  for (const ids of [p.MusicBrainzAlbumArtist, p.MusicBrainzArtist]) {
    const mbid = String(ids || '').split(/[/;,]/)[0].trim().toLowerCase();
    if (UUID.test(mbid)) return { mbid, name: idx.artists.get(mbid)?.name || item.AlbumArtist || item.ArtistItems?.[0]?.Name || '' };
  }
  for (const a of [...(item.AlbumArtists || []), ...(item.ArtistItems || [])]) {
    const info = idx.artistsByEmbyId.get(a.Id) || idx.artistNames.get(norm(a.Name));
    if (info?.mbid) return { mbid: info.mbid, name: info.name };
  }
  return null;
}

/**
 * What an Emby user plays, per artist: MB artist id -> { mbid, name, plays, recentPlays, favourite,
 * favouriteAlbums, favouriteTracks }. Artists without a MusicBrainz ID are left out.
 */
export async function listening(userId, idx) {
  const base = `/Users/${encodeURIComponent(userId)}/Items?Recursive=true&Fields=ProviderIds&EnableImages=false`;
  const [played, favourites] = await Promise.all([
    embyFetch(`${base}&IncludeItemTypes=Audio&Filters=IsPlayed&SortBy=PlayCount,DatePlayed&SortOrder=Descending&Limit=5000`),
    embyFetch(`${base}&IncludeItemTypes=Audio,MusicAlbum,MusicArtist&Filters=IsFavorite&Limit=2000`),
  ]);
  const out = new Map();
  const entry = (item) => {
    const a = artistOf(item, idx);
    if (!a) return null;
    if (!out.has(a.mbid)) out.set(a.mbid, { ...a, plays: 0, recentPlays: 0, favourite: false, favouriteAlbums: 0, favouriteTracks: 0 });
    return out.get(a.mbid);
  };
  const recent = Date.now() - RECENT_DAYS * 864e5;
  for (const t of played?.Items || []) {
    const e = entry(t);
    if (!e) continue;
    const n = t.UserData?.PlayCount || 1;
    e.plays += n;
    if (Date.parse(t.UserData?.LastPlayedDate || '') > recent) e.recentPlays += n;
  }
  for (const item of favourites?.Items || []) {
    const e = entry(item);
    if (!e) continue;
    if (item.Type === 'MusicArtist') e.favourite = true;
    else if (item.Type === 'MusicAlbum') e.favouriteAlbums++;
    else e.favouriteTracks++;
  }
  return out;
}
