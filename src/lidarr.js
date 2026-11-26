// Lidarr API v1 client
import { config, errorReason } from './config.js';

async function api(method, path, body, conn) {
  const url = conn?.url || config.lidarrUrl;
  const key = conn?.apiKey || config.lidarrApiKey;
  if (!url || !key) throw new Error('Lidarr is not set up (Settings)');
  const res = await fetch(`${url}/api/v1${path}`, {
    method,
    headers: { 'X-Api-Key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = Array.isArray(j) ? j.map((e) => e.errorMessage).join('; ') : j.message || text;
    } catch {}
    const err = new Error(`Lidarr ${method} ${path.split('?')[0]} -> ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

export const systemStatus = () => api('GET', '/system/status');

/** Tests a (possibly unsaved) address + key and fetches the options for the dropdowns. */
export async function testConnection(url, apiKey) {
  const conn = { url, apiKey };
  let status;
  try {
    status = await api('GET', '/system/status', null, conn);
  } catch (e) {
    if (e.status === 401) throw new Error('Lidarr rejected the API key');
    if (e.status) throw new Error(`Lidarr responded ${e.status} – is the address correct?`);
    throw new Error(`Cannot reach ${url} (${errorReason(e)}) – check the address and port`);
  }
  const [roots, qps, mps] = await Promise.all([
    api('GET', '/rootfolder', null, conn),
    api('GET', '/qualityprofile', null, conn),
    api('GET', '/metadataprofile', null, conn),
  ]);
  return {
    version: status.version,
    roots: roots.map((r) => r.path),
    qualityProfiles: qps.map((q) => ({ id: q.id, name: q.name })),
    metadataProfiles: mps.map((m) => ({ id: m.id, name: m.name })),
  };
}

export function resetDefaults() {
  defaultsCache = null;
}

let defaultsCache = null;
export async function getDefaults() {
  if (defaultsCache) return defaultsCache;
  const [roots, qps, mps] = await Promise.all([api('GET', '/rootfolder'), api('GET', '/qualityprofile'), api('GET', '/metadataprofile')]);
  const root = config.lidarrRootFolder ? roots.find((r) => r.path === config.lidarrRootFolder) : roots[0];
  const qp = config.lidarrQualityProfileId ? qps.find((q) => q.id === config.lidarrQualityProfileId) : qps[0];
  const mp = config.lidarrMetadataProfileId ? mps.find((m) => m.id === config.lidarrMetadataProfileId) : mps[0];
  if (!root) throw new Error('No root folder found in Lidarr (check LIDARR_ROOT_FOLDER)');
  if (!qp) throw new Error('No quality profile found in Lidarr (check LIDARR_QUALITY_PROFILE_ID)');
  if (!mp) throw new Error('No metadata profile found in Lidarr (check LIDARR_METADATA_PROFILE_ID)');
  defaultsCache = {
    rootFolderPath: root.path,
    qualityProfileId: qp.id,
    metadataProfileId: mp.id,
    labels: { root: root.path, quality: qp.name, metadata: mp.name },
    options: {
      roots: roots.map((r) => r.path),
      qualityProfiles: qps.map((q) => ({ id: q.id, name: q.name })),
      metadataProfiles: mps.map((m) => ({ id: m.id, name: m.name })),
    },
  };
  return defaultsCache;
}

export async function getArtistByMbid(mbid) {
  const list = await api('GET', `/artist?mbId=${encodeURIComponent(mbid)}`);
  return (list || []).find((a) => a.foreignArtistId === mbid) || null;
}

export const listArtists = () => api('GET', '/artist');
/** Every album Lidarr knows about, for all artists. */
export const listAlbums = () => api('GET', '/album');

export async function getArtist(id) {
  return api('GET', `/artist/${id}`);
}

export async function lookupArtist(mbid) {
  const list = await api('GET', `/artist/lookup?term=${encodeURIComponent('lidarr:' + mbid)}`);
  return (list || []).find((a) => a.foreignArtistId === mbid) || list?.[0] || null;
}

/** Adds an artist to Lidarr without monitoring anything automatically (we pick albums ourselves). */
export async function addArtist(mbid, { monitorNew = false } = {}) {
  const lookup = await lookupArtist(mbid);
  if (!lookup) throw new Error('Lidarr could not find the artist in its metadata database');
  const d = await getDefaults();
  return api('POST', '/artist', {
    ...lookup,
    qualityProfileId: d.qualityProfileId,
    metadataProfileId: d.metadataProfileId,
    rootFolderPath: d.rootFolderPath,
    monitored: true,
    monitorNewItems: monitorNew ? 'all' : 'none',
    addOptions: { monitor: 'none', searchForMissingAlbums: false },
  });
}

/**
 * Makes sure the artist is monitored – Lidarr only looks for monitored albums of monitored artists,
 * so this keeps requested albums wanted going forward. With `monitorNew` set (true/false) it also
 * decides whether new releases are monitored; left out, that setting is kept as it is.
 */
export async function setArtistMonitoring(artist, { monitorNew } = {}) {
  const wanted = monitorNew === undefined ? artist.monitorNewItems : monitorNew ? 'all' : 'none';
  if (artist.monitored && artist.monitorNewItems === wanted) return artist;
  return api('PUT', `/artist/${artist.id}`, { ...artist, monitored: true, monitorNewItems: wanted });
}

export const getAlbums = (artistId) => api('GET', `/album?artistId=${artistId}&includeAllArtistAlbums=true`);

export const monitorAlbums = (albumIds) => api('PUT', '/album/monitor', { albumIds, monitored: true });

export const searchAlbums = (albumIds) => api('POST', '/command', { name: 'AlbumSearch', albumIds });

export const refreshArtist = (artistId) => api('POST', '/command', { name: 'RefreshArtist', artistId });

export async function getQueue() {
  const data = await api('GET', '/queue?page=1&pageSize=1000&includeUnknownArtistItems=false');
  return data?.records || [];
}

/** The images Lidarr has for the artist (fanart/theaudiodb) – used on the artist page. */
export async function artistImages(mbid) {
  try {
    const a = await lookupArtist(mbid);
    if (!a) return {};
    const img = (type) => a.images?.find((i) => i.coverType === type)?.remoteUrl || null;
    return { poster: img('poster'), fanart: img('fanart'), banner: img('banner'), overview: a.overview || '' };
  } catch {
    return {};
  }
}
