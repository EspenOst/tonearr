import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, errorReason } from './config.js';
import * as settings from './settings.js';
import * as db from './db.js';
import * as emby from './emby.js';
import * as mb from './musicbrainz.js';
import * as lidarr from './lidarr.js';
import { startWorker, runOnce, computeStatus } from './worker.js';
import * as notify from './notify.js';
import * as discover from './discover.js';
import { isEmail } from './mailer.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COOKIE = 'tonearr_session';

// ---------- small helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((c) => c[0]));

async function readJson(req) {
  if (!/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected JSON');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 200_000) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

// Simple brute-force protection for sign-in
const loginAttempts = new Map();
function checkLoginRate(ip) {
  const now = Date.now();
  const a = (loginAttempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (a.length >= 10) throw new HttpError(429, 'Too many sign-in attempts – please wait a bit');
  a.push(now);
  loginAttempts.set(ip, a);
}

// ---------- routing ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, admin: !!opts.admin });
}

// ---------- status helpers ----------
async function libraryIndex() {
  return emby.getIndex().catch(() => null);
}

function annotate(list, idx, reqMap, artistName, lidarrAlbums) {
  for (const a of list) {
    const la = lidarrAlbums?.get(a.mbid);
    // Lidarr knows the release IDs (editions) – Emby files are sometimes tagged with only those
    const releaseIds = (la?.releases || []).map((r) => r.foreignReleaseId).filter(Boolean);
    const inEmby = emby.findAlbum(idx, { rgMbid: a.mbid, releaseIds, artistName: a.artist?.name || artistName, title: a.title });
    if (inEmby) { a.status = 'available'; continue; }
    const r = reqMap.get(a.mbid);
    if (r) { a.status = r.status; a.progress = r.progress; a.requestId = r.requestId; continue; }
    // Monitored in Lidarr but without files is still requestable: Lidarr may never have searched for it,
    // and a request triggers that search
    a.status = la?.statistics?.trackFileCount > 0 ? 'downloaded' : null;
  }
  return list;
}

// ---------- auth ----------
// First-time setup: until an Emby address is saved, the sign-in form also asks for it.
// Only an Emby administrator can complete it – that saves the address and signs them in.
route('POST', '/api/auth/login', async (req, res) => {
  const ip = req.socket.remoteAddress;
  checkLoginRate(ip);
  const body = await readJson(req);
  const { username, password } = body;
  if (!username) throw new HttpError(400, 'Username is missing');

  const setup = settings.isSetupRequired();
  let embyUrl = config.embyUrl;
  if (setup) {
    try {
      embyUrl = settings.normalizeUrl(body.embyUrl);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (!embyUrl) throw new HttpError(400, 'Enter the address of your Emby server');
  }

  let user;
  try {
    user = await emby.authenticate(String(username), String(password ?? ''), embyUrl);
  } catch (e) {
    const reason = errorReason(e);
    console.error('[auth] Emby error:', reason);
    throw new HttpError(502, setup ? `Cannot reach Emby at ${embyUrl} (${reason}) – check the address and port` : 'Cannot reach Emby');
  }
  if (!user) throw new HttpError(401, 'Wrong username or password');
  if (setup) {
    if (!user.isAdmin) throw new HttpError(403, 'Only an Emby administrator can set up Tonearr');
    if (settings.isSetupRequired()) { // another admin may have finished setup in the meantime
      try {
        settings.save({ embyUrl });
      } catch (e) {
        throw new HttpError(500, e.message);
      }
      console.log(`[settings] First-time setup: Emby at ${embyUrl}, by ${user.name}`);
    }
  }
  loginAttempts.delete(ip);
  const token = db.createSession(user);
  console.log(`[auth] ${user.name} signed in${user.isAdmin ? ' (admin)' : ''}`);
  send(res, 200, { user: { name: user.name, isAdmin: user.isAdmin } }, {
    'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionDays * 86400}`,
  });
}, { auth: false });

route('POST', '/api/auth/logout', async (req, res) => {
  db.deleteSession(cookies(req)[COOKIE]);
  send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
}, { auth: false });

route('GET', '/api/me', async (req, res, { session }) => {
  send(res, 200, {
    user: {
      id: session.userId,
      name: session.userName,
      isAdmin: session.isAdmin,
      // Admins get a notice about settings that still need to be filled in
      missingSettings: session.isAdmin ? settings.missingSettings() : [],
      // Shows the Notifications page when the admin has switched email on
      emailEnabled: settings.isEmailEnabled(),
    },
    appName: config.appName,
    autoApprove: config.autoApprove,
  });
});

// ---------- search ----------
route('GET', '/api/search', async (req, res, { query }) => {
  const q = (query.get('q') || '').trim().slice(0, 200);
  const type = query.get('type') || 'artist';
  if (q.length < 2) return send(res, 200, { results: [] });
  const [idx, reqMap] = [await libraryIndex(), db.itemStatusMap()];

  if (type === 'artist') {
    const results = await mb.searchArtists(q);
    for (const a of results) a.inLibrary = !!emby.findArtist(idx, { mbid: a.mbid });
    return send(res, 200, { results });
  }
  if (type === 'album') {
    const results = annotate(await mb.searchAlbums(q), idx, reqMap);
    return send(res, 200, { results });
  }
  if (type === 'song') {
    const results = await mb.searchSongs(q);
    const albums = results.filter((s) => s.album).map((s) => ({ ...s.album, artist: s.artist }));
    annotate(albums, idx, reqMap);
    results.forEach((s) => { if (s.album) s.album.status = albums.find((a) => a.mbid === s.album.mbid)?.status || null; });
    return send(res, 200, { results });
  }
  throw new HttpError(400, 'Unknown search type');
});

// ---------- artist ----------
const VARIOUS_ARTISTS_MSG = "Various Artists and [unknown] can't be requested – search for the artist instead";

route('GET', '/api/artist/:mbid', async (req, res, { params }) => {
  if (!UUID.test(params.mbid)) throw new HttpError(400, 'Invalid MBID');
  if (mb.isBlockedArtist(params.mbid)) throw new HttpError(404, VARIOUS_ARTISTS_MSG);
  const [artist, images, lidarrArtist] = await Promise.all([
    mb.getArtist(params.mbid),
    lidarr.artistImages(params.mbid),
    lidarr.getArtistByMbid(params.mbid).catch(() => null),
  ]);
  if (!artist) throw new HttpError(404, 'Artist not found');
  if (mb.isBlockedArtist(artist.mbid, artist.name)) throw new HttpError(404, VARIOUS_ARTISTS_MSG);
  const releaseGroups = await mb.getArtistReleaseGroups(params.mbid);
  let lidarrAlbums = null;
  if (lidarrArtist) {
    const albums = await lidarr.getAlbums(lidarrArtist.id).catch(() => []);
    lidarrAlbums = new Map(albums.map((a) => [a.foreignAlbumId, a]));
  }
  const idx = await libraryIndex();
  annotate(releaseGroups, idx, db.itemStatusMap(), artist.name, lidarrAlbums);
  send(res, 200, {
    artist: { ...artist, ...images, inLibrary: !!emby.findArtist(idx, { mbid: artist.mbid, name: artist.name }) || releaseGroups.some((r) => r.status === 'available'),inLidarr: !!lidarrArtist, monitorNew: lidarrArtist?.monitorNewItems === 'all' },
    releaseGroups,
  });
});

// ---------- discover ----------
const SHELF_SIZE = 30;

route('GET', '/api/discover', async (req, res, { session }) => {
  const idx = await libraryIndex();
  const reqMap = db.itemStatusMap();
  // Albums already on the server are left out – the point is finding something to request
  const mark = (list) => annotate(list, idx, reqMap);
  const shelf = (list) => mark(list).filter((a) => a.status !== 'available');
  const shelves = [];
  const [releases, personal, popular] = await Promise.allSettled([
    discover.releaseShelves(idx),
    idx ? discover.personalShelves(session.userId, idx, mark, SHELF_SIZE * 2) : null,
    discover.popularNow(),
  ]);
  if (releases.status === 'rejected') shelves.push({ id: 'new', items: [], error: releases.reason.message });
  else if (releases.value) {
    shelves.push({ id: 'new', items: shelf(releases.value.newReleases) });
    shelves.push({ id: 'upcoming', items: shelf(releases.value.upcoming) });
  }
  if (personal.status === 'rejected') shelves.push({ id: 'yours', items: [], error: personal.reason.message });
  else if (personal.value) {
    shelves.push({ id: 'yours', ...personal.value.yours });
    if (personal.value.similar) shelves.push({ id: 'similar', ...personal.value.similar });
  }
  shelves.push({ id: 'missing', items: discover.missingFromCollection(idx, mark, SHELF_SIZE * 2) });
  if (popular.status === 'rejected') shelves.push({ id: 'popular', items: [], error: popular.reason.message });
  else if (popular.value) shelves.push({ id: 'popular', items: shelf(popular.value) });
  shelves.push({ id: 'others', items: mark(discover.requestedByOthers(session.userId, SHELF_SIZE)) });
  // An album shows up once, on the first shelf that has it
  const seen = new Set();
  for (const s of shelves) {
    s.items = s.items.filter((a) => !seen.has(a.mbid) && seen.add(a.mbid)).slice(0, SHELF_SIZE);
  }
  send(res, 200, { shelves });
});

// ---------- the user's own notification settings ----------
const userPrefs = (session) => {
  const u = db.getUser(session.userId) || {};
  return { email: u.email || '', notify: !!u.notify, events: u.events || notify.DEFAULT_EVENTS };
};

route('GET', '/api/me/notifications', async (req, res, { session }) => {
  send(res, 200, { prefs: userPrefs(session), events: notify.EVENTS, enabled: settings.isEmailEnabled() });
});

route('PUT', '/api/me/notifications', async (req, res, { session }) => {
  const b = await readJson(req);
  const email = String(b.email || '').trim().slice(0, 254);
  if (email && !isEmail(email)) throw new HttpError(400, "That doesn't look like a valid email address");
  if (b.notify && !email) throw new HttpError(400, 'Enter your email address to get notifications');
  const events = (Array.isArray(b.events) ? b.events : []).filter((e) => e in notify.EVENTS);
  db.setUser(session.userId, { name: session.userName, email, notify: !!b.notify, events });
  send(res, 200, { prefs: userPrefs(session) });
});

const lastUserTest = new Map();
route('POST', '/api/me/notifications/test', async (req, res, { session }) => {
  if (!settings.isEmailEnabled()) throw new HttpError(400, 'Email notifications are turned off');
  const { email } = userPrefs(session);
  if (!email) throw new HttpError(400, 'Save your email address first');
  if (Date.now() - (lastUserTest.get(session.userId) || 0) < 60_000) throw new HttpError(429, 'Wait a minute before sending another test');
  lastUserTest.set(session.userId, Date.now());
  try {
    await notify.sendTest({ host: config.smtpHost, port: config.smtpPort, security: config.smtpSecurity, user: config.smtpUser, password: config.smtpPassword }, config.emailFrom, email);
  } catch (e) {
    console.error(`[email] Test to ${session.userName} failed: ${e.message}`);
    throw new HttpError(502, 'The test email could not be sent – ask an administrator to check the mail settings');
  }
  send(res, 200, { ok: true, to: email });
});

// ---------- requests ----------
const ACTIVE_ITEM = new Set(['pending', 'approved', 'waiting', 'searching', 'downloading', 'downloaded', 'available']);

route('POST', '/api/requests', async (req, res, { session }) => {
  const body = await readJson(req);
  const { artistMbid, artistName } = body;
  if (!UUID.test(artistMbid || '')) throw new HttpError(400, 'Invalid artist');
  if (mb.isBlockedArtist(artistMbid, artistName)) throw new HttpError(400, VARIOUS_ARTISTS_MSG);
  const albums = (Array.isArray(body.albums) ? body.albums : []).slice(0, 300).filter((a) => UUID.test(a?.mbid || ''));
  if (!albums.length) throw new HttpError(400, 'Select at least one album');

  // Skip albums that are already on the server or already requested
  const idx = await libraryIndex();
  const reqMap = db.itemStatusMap();
  const fresh = albums.filter((a) => {
    if (emby.findAlbum(idx, { rgMbid: a.mbid, artistName, title: a.title })) return false;
    const r = reqMap.get(a.mbid);
    return !(r && ACTIVE_ITEM.has(r.status));
  });
  if (!fresh.length) throw new HttpError(409, 'Everything you selected is already available or requested');

  const approved = session.isAdmin || config.autoApprove;
  const request = db.createRequest({
    userId: session.userId,
    userName: session.userName,
    artistMbid,
    artistName: String(artistName || '').slice(0, 300),
    monitorNew: !!body.monitorNew,
    status: approved ? 'processing' : 'pending',
    items: fresh.map((a) => ({
      mbid: a.mbid,
      title: String(a.title || '').slice(0, 300),
      type: String(a.type || '').slice(0, 40),
      year: Number(a.year) || null,
      status: approved ? 'approved' : 'pending',
    })),
  });
  console.log(`[request] #${request.id} ${session.userName}: ${request.artistName} (${request.items.length} album)${approved ? '' : ' – pending approval'}`);
  if (approved) setImmediate(runOnce);
  else notify.newPendingRequest(request);
  send(res, 201, { request, skipped: albums.length - fresh.length });
});

route('GET', '/api/requests', async (req, res, { session, query }) => {
  const all = session.isAdmin && query.get('scope') !== 'mine';
  const list = db.listRequests(all ? {} : { userId: session.userId });
  send(res, 200, { requests: list.slice(0, 500) });
});

route('POST', '/api/requests/:id/approve', async (req, res, { params }) => {
  const r = db.getRequest(params.id);
  if (!r) throw new HttpError(404, 'Not found');
  r.items.forEach((i) => { if (i.status === 'pending' || i.status === 'declined') i.status = 'approved'; });
  db.updateRequest(r, { status: computeStatus({ ...r, status: 'processing' }) });
  setImmediate(runOnce);
  send(res, 200, { request: r });
}, { admin: true });

route('POST', '/api/requests/:id/decline', async (req, res, { params }) => {
  const r = db.getRequest(params.id);
  if (!r) throw new HttpError(404, 'Not found');
  r.items.forEach((i) => { if (i.status === 'pending') i.status = 'declined'; });
  db.updateRequest(r, { status: 'declined' });
  send(res, 200, { request: r });
}, { admin: true });

route('POST', '/api/requests/:id/retry', async (req, res, { params, session }) => {
  const r = db.getRequest(params.id);
  if (!r) throw new HttpError(404, 'Not found');
  if (!session.isAdmin && r.userId !== session.userId) throw new HttpError(403, 'Access denied');
  if (r.status === 'pending' || r.status === 'declined') throw new HttpError(400, 'The request has not been approved');
  r.items.forEach((i) => {
    if (i.status === 'failed' || i.status === 'waiting') { i.status = 'approved'; i.attempts = 0; i.error = ''; }
  });
  r.refreshSent = false;
  r.notified = (r.notified || []).filter((e) => e !== 'failed'); // a new failure is worth a new email
  db.updateRequest(r, { status: computeStatus(r), error: '' });
  setImmediate(runOnce);
  send(res, 200, { request: r });
});

route('DELETE', '/api/requests/:id', async (req, res, { params, session }) => {
  const r = db.getRequest(params.id);
  if (!r) throw new HttpError(404, 'Not found');
  if (!session.isAdmin && !(r.userId === session.userId && r.status === 'pending')) throw new HttpError(403, 'Only pending requests can be deleted');
  db.deleteRequest(r.id);
  send(res, 200, { ok: true });
});

// ---------- settings ----------
route('GET', '/api/public/status', async (req, res) => {
  send(res, 200, { setupRequired: settings.isSetupRequired(), appName: config.appName || 'Tonearr' });
}, { auth: false });

route('GET', '/api/settings', async (req, res) => {
  send(res, 200, { settings: settings.view(), missingSettings: settings.missingSettings() });
}, { admin: true });

// Use the saved key when the client sends the masked value (or nothing)
const keyOrSaved = (v, saved) => (!v || settings.isMasked(v) ? saved : String(v).trim());

route('POST', '/api/settings/test/emby', async (req, res) => {
  const b = await readJson(req);
  const url = settings.normalizeUrl(b.url);
  const key = keyOrSaved(b.apiKey, config.embyApiKey);
  if (!url || !key) throw new HttpError(400, 'Enter an address and API key');
  try {
    send(res, 200, await emby.testConnection(url, key));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}, { admin: true });

route('POST', '/api/settings/test/lidarr', async (req, res) => {
  const b = await readJson(req);
  const url = settings.normalizeUrl(b.url);
  const key = keyOrSaved(b.apiKey, config.lidarrApiKey);
  if (!url || !key) throw new HttpError(400, 'Enter an address and API key');
  try {
    send(res, 200, await lidarr.testConnection(url, key));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}, { admin: true });

route('PUT', '/api/settings', async (req, res) => {
  const b = await readJson(req);
  let embyUrl, embyKey;
  try {
    embyUrl = 'embyUrl' in b ? settings.normalizeUrl(b.embyUrl) : config.embyUrl;
    if ('lidarrUrl' in b) settings.normalizeUrl(b.lidarrUrl);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  embyKey = keyOrSaved(b.embyApiKey, config.embyApiKey);
  // Emby handles sign-in – never save an Emby connection that does not work (or you lock yourself out)
  if (!embyUrl || !embyKey) throw new HttpError(400, 'Emby address and API key are required');
  if (embyUrl !== config.embyUrl || embyKey !== config.embyApiKey) {
    try {
      await emby.testConnection(embyUrl, embyKey);
    } catch (e) {
      throw new HttpError(400, `Not saved: ${e.message}`);
    }
  }
  let changed;
  try {
    changed = settings.save(b);
  } catch (e) {
    throw new HttpError(e instanceof settings.InvalidSetting ? 400 : 500, e.message);
  }
  console.log(`[settings] Saved${changed.length ? ': ' + changed.join(', ') : ' (no changes)'}`);
  send(res, 200, { settings: settings.view(), changed });
}, { admin: true });

// Sends a test email with the values in the form (the saved password is used if it wasn't changed)
route('POST', '/api/settings/test/email', async (req, res) => {
  const b = await readJson(req);
  const to = settings.splitEmails(b.to)[0];
  if (!b.smtpHost) throw new HttpError(400, 'Enter the mail server');
  if (!b.emailFrom) throw new HttpError(400, 'Enter the sender address');
  if (!isEmail(to)) throw new HttpError(400, 'Enter at least one valid address under "Notify about new requests" to send the test to');
  const smtp = {
    host: String(b.smtpHost).trim().replace(/^smtps?:\/\//i, ''),
    port: Number(b.smtpPort) || 587,
    security: ['starttls', 'tls', 'none'].includes(b.smtpSecurity) ? b.smtpSecurity : 'starttls',
    user: String(b.smtpUser || '').trim(),
    password: keyOrSaved(b.smtpPassword, config.smtpPassword),
  };
  try {
    await notify.sendTest(smtp, String(b.emailFrom).trim(), to);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  console.log(`[email] Test email sent to ${to}`);
  send(res, 200, { ok: true, to });
}, { admin: true });

settings.onChange((changed) => {
  if (changed.some((k) => k.startsWith('emby'))) {
    emby.resetIndex();
    emby.getIndex().catch(() => {});
  }
  if (changed.some((k) => k.startsWith('lidarr'))) lidarr.resetDefaults();
  if (changed.includes('listenbrainzEnabled')) discover.warmUp();
  setImmediate(runOnce);
});

// ---------- admin ----------
route('GET', '/api/admin/status', async (req, res) => {
  const out = { config: { embyUrl: config.embyUrl, lidarrUrl: config.lidarrUrl, autoApprove: config.autoApprove } };
  await Promise.all([
    emby.systemInfo().then((i) => (out.emby = { ok: true, name: i.ServerName, version: i.Version })).catch((e) => (out.emby = { ok: false, error: e.message })),
    lidarr.systemStatus().then((s) => (out.lidarr = { ok: true, version: s.version })).catch((e) => (out.lidarr = { ok: false, error: e.message })),
  ]);
  if (out.lidarr.ok) out.lidarr.defaults = await lidarr.getDefaults().then((d) => ({ ...d.labels, options: d.options })).catch((e) => ({ error: e.message }));
  out.library = emby.indexInfo();
  send(res, 200, out);
}, { admin: true });

// Lightweight – polled by the settings page while background lookups are running
route('GET', '/api/admin/library', async (req, res) => {
  send(res, 200, { library: emby.indexInfo() });
}, { admin: true });

route('POST', '/api/admin/sync', async (req, res) => {
  await emby.getIndex({ force: true }).catch(() => {});
  await runOnce();
  send(res, 200, { ok: true, library: emby.indexInfo() });
}, { admin: true });

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
async function serveStatic(req, res, pathname) {
  let file = path.join(PUBLIC, path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) file = path.join(PUBLIC, 'index.html');
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(PUBLIC, 'index.html'); // SPA fallback
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache', // small files – always revalidate so updates come through
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return await serveStatic(req, res, url.pathname);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const session = db.getSession(cookies(req)[COOKIE]);
      if (r.auth && !session) throw new HttpError(401, 'Not signed in');
      if (r.admin && !session?.isAdmin) throw new HttpError(403, 'Administrators only');
      return await r.handler(req, res, { params, query: url.searchParams, session });
    }
    throw new HttpError(404, 'Unknown endpoint');
  } catch (e) {
    const status = e.status && e.status < 600 && e instanceof HttpError ? e.status : 500;
    const detail = e.cause ? ` (${errorReason(e)})` : '';
    if (status === 500) console.error(`[http] ${req.method} ${url.pathname}: ${e.message}${detail}`);
    if (!res.headersSent) send(res, status, { error: status === 500 ? `Something went wrong: ${e.message}${detail}` : e.message });
  }
});

// Catch an unwritable data folder at startup instead of failing on the first save
function checkDataDir() {
  const probe = path.join(config.dataDir, '.write-test');
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (e) {
    console.error(`[data] ERROR: cannot write to ${config.dataDir} (${e.code || e.message}). Settings, requests and sign-ins will not be saved.`);
    console.error(`[data] Make the folder writable for uid ${process.getuid?.() ?? '?'}, e.g.: sudo chown -R ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} <folder>`);
  }
}

server.listen(config.port, () => {
  checkDataDir();
  console.log(`${config.appName} ${config.version} running on http://localhost:${config.port}`);
  if (settings.isSetupRequired()) console.log('[settings] Not set up – open the web page and sign in with an Emby administrator account');
  else if (!settings.isEmbyConfigured()) console.log('[settings] The Emby API key is not set up yet (Settings)');
  else emby.getIndex().catch(() => {});
  if (!settings.isLidarrConfigured()) console.log('[settings] Lidarr is not set up yet (Settings)');
  if (settings.isEmailEnabled()) console.log(`[email] Notifications on, via ${config.smtpHost}:${config.smtpPort}`);
  discover.warmUp();
  startWorker();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { db.flush(); process.exit(0); });
