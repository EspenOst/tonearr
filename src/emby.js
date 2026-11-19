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
    artists: new Map(), // MB artist id -> { id, name }
    artistNames: new Map(),
    releaseOnly: [], // albums with a release ID but no release group ID: [{ releaseId, info }]
    albumCount: 0,
  };
  for (const a of albums?.Items || []) {
    const info = { embyId: a.Id, name: a.Name, artist: a.AlbumArtist || a.AlbumArtists?.[0]?.Name || '' };
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
    const info = { embyId: a.Id, name: a.Name };
    if (p.MusicBrainzArtist) idx.artists.set(p.MusicBrainzArtist.toLowerCase(), info);
    idx.artistNames.set(norm(a.Name), info);
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
