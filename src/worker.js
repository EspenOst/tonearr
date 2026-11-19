// Background job: sends approved requests to Lidarr and updates status from Lidarr + Emby.
import { config } from './config.js';
import * as db from './db.js';
import * as lidarr from './lidarr.js';
import * as emby from './emby.js';
import { isSetupRequired, isLidarrConfigured } from './settings.js';

const TO_PROCESS = new Set(['approved', 'waiting']);
const TRACKED = new Set(['searching', 'downloading', 'downloaded']);
const ACTIVE = new Set([...TO_PROCESS, ...TRACKED]);
const MAX_ATTEMPTS = 30; // ~15 min at a 30 sec interval

export function computeStatus(req) {
  if (req.status === 'pending' || req.status === 'declined') return req.status;
  const s = req.items.map((i) => i.status);
  if (s.length && s.every((x) => x === 'available')) return 'available';
  const active = s.some((x) => ACTIVE.has(x));
  if (s.some((x) => x === 'available')) return 'partial';
  if (!active && s.some((x) => x === 'failed')) return 'failed';
  if (s.some((x) => x === 'downloading')) return 'downloading';
  if (s.some((x) => x === 'downloaded')) return 'downloaded';
  return 'processing';
}

/** Sends the outstanding albums in a request to Lidarr. */
export async function processRequest(req) {
  const todo = req.items.filter((i) => TO_PROCESS.has(i.status));
  if (!todo.length) return;

  let artist = null;
  if (req.lidarrArtistId) artist = await lidarr.getArtist(req.lidarrArtistId).catch(() => null);
  if (!artist) artist = await lidarr.getArtistByMbid(req.artistMbid);

  if (!artist) {
    artist = await lidarr.addArtist(req.artistMbid, { monitorNew: req.monitorNew });
    for (const i of todo) i.status = 'waiting';
    db.updateRequest(req, { lidarrArtistId: artist.id, artistAddedByUs: true, error: '' });
    db.updateRequest(req, { status: computeStatus(req) });
    console.log(`[worker] #${req.id}: added ${req.artistName} to Lidarr (id ${artist.id}), waiting for album list`);
    return; // Lidarr fetches the album list asynchronously – we continue next round
  }

  if (req.lidarrArtistId !== artist.id) req.lidarrArtistId = artist.id;
  if (req.monitorNew) await lidarr.setMonitorNew(artist, true);

  const albums = await lidarr.getAlbums(artist.id);
  const ready = [];
  for (const item of todo) {
    const album = albums.find((a) => a.foreignAlbumId === item.mbid);
    if (album) {
      item.lidarrAlbumId = album.id;
      item.status = 'searching';
      item.error = '';
      ready.push(album.id);
      continue;
    }
    item.status = 'waiting';
    item.attempts = (item.attempts || 0) + 1;
    // An existing artist may be missing new releases – ask Lidarr to refresh once
    if (item.attempts === 2 && !req.artistAddedByUs && !req.refreshSent) {
      req.refreshSent = true;
      await lidarr.refreshArtist(artist.id).catch(() => {});
    }
    if (item.attempts >= MAX_ATTEMPTS) {
      item.status = 'failed';
      item.error = 'The album never showed up in Lidarr. Check that the metadata profile includes this type (EP/Single/Live etc.).';
    }
  }
  if (ready.length) {
    await lidarr.monitorAlbums(ready);
    await lidarr.searchAlbums(ready);
    console.log(`[worker] #${req.id}: monitoring and searching for ${ready.length} album(s) for ${req.artistName}`);
  }
  db.updateRequest(req, { status: computeStatus(req), error: '' });
}

/** Updates the status of all active requests based on the Emby library and Lidarr. */
export async function syncStatuses() {
  const reqs = db.listRequests().filter((r) => r.status !== 'declined' && r.items.some((i) => i.status !== 'available' && i.status !== 'declined'));
  if (!reqs.length) return;

  const idx = await emby.getIndex().catch(() => null);
  const needsLidarr = isLidarrConfigured() && reqs.some((r) => r.items.some((i) => TRACKED.has(i.status)));
  const queue = needsLidarr ? await lidarr.getQueue().catch(() => []) : [];
  const queueByAlbum = new Map();
  for (const q of queue) {
    const prev = queueByAlbum.get(q.albumId);
    queueByAlbum.set(q.albumId, prev ? { size: prev.size + (q.size || 0), sizeleft: prev.sizeleft + (q.sizeleft || 0) } : { size: q.size || 0, sizeleft: q.sizeleft || 0 });
  }
  const albumsByArtist = new Map();

  for (const req of reqs) {
    let changed = false;
    for (const item of req.items) {
      if (item.status === 'available' || item.status === 'declined') continue;
      const before = JSON.stringify([item.status, item.progress]);

      const inEmby = emby.findAlbum(idx, { rgMbid: item.mbid, releaseIds: item.releaseIds || [], artistName: req.artistName, title: item.title });
      if (inEmby) {
        item.status = 'available';
        item.embyId = inEmby.embyId;
        item.progress = null;
        item.error = '';
      } else if (needsLidarr && TRACKED.has(item.status) && req.lidarrArtistId && item.lidarrAlbumId) {
        if (!albumsByArtist.has(req.lidarrArtistId)) {
          albumsByArtist.set(req.lidarrArtistId, await lidarr.getAlbums(req.lidarrArtistId).catch(() => null));
        }
        const album = albumsByArtist.get(req.lidarrArtistId)?.find((a) => a.id === item.lidarrAlbumId);
        if (album) {
          item.releaseIds = (album.releases || []).map((r) => r.foreignReleaseId).filter(Boolean);
          const q = queueByAlbum.get(album.id);
          const st = album.statistics || {};
          if (q) {
            item.status = 'downloading';
            item.progress = q.size ? Math.max(0, Math.min(100, Math.round(100 * (1 - q.sizeleft / q.size)))) : null;
          } else if (st.trackFileCount > 0) {
            item.status = 'downloaded';
            item.progress = Math.round(st.percentOfTracks ?? 100);
          } else {
            item.status = 'searching';
            item.progress = null;
          }
        }
      }
      if (JSON.stringify([item.status, item.progress]) !== before) changed = true;
    }
    const status = computeStatus(req);
    if (changed || status !== req.status) db.updateRequest(req, { status });
  }
}

let running = false;
export async function runOnce() {
  if (running || isSetupRequired()) return;
  running = true;
  try {
    for (const req of isLidarrConfigured() ? db.listRequests().reverse() : []) {
      if (req.status === 'pending' || req.status === 'declined') continue;
      if (!req.items.some((i) => TO_PROCESS.has(i.status))) continue;
      try {
        await processRequest(req);
      } catch (e) {
        console.error(`[worker] #${req.id} failed:`, e.message);
        db.updateRequest(req, { error: e.message });
      }
    }
    await syncStatuses();
  } catch (e) {
    console.error('[worker] sync failed:', e.message);
  } finally {
    running = false;
  }
}

export function startWorker() {
  setTimeout(runOnce, 3000);
  setInterval(runOnce, config.workerIntervalSec * 1000);
  setInterval(db.pruneSessions, 3600 * 1000);
}
