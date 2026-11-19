// Simple JSON file database. Keeps everything in memory and writes atomically to disk.
// More than enough for a home server with a handful of users.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
const file = path.join(config.dataDir, 'db.json');

let state = { sessions: {}, requests: [], users: {}, nextId: 1 };
if (existsSync(file)) {
  try {
    state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    console.error('[db] Could not read db.json:', e.message);
    renameSync(file, file + '.corrupt-' + Date.now());
  }
}

// A failed write must never crash the server (it runs in a timer, so it would be uncaught)
function writeNow() {
  try {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, file);
  } catch (e) {
    console.error(`[db] Could not save ${file} (${e.code || e.message}) – is the data folder writable?`);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 200);
}
export function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeNow();
}

const now = () => new Date().toISOString();

// ---------- Sessions ----------
export function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  state.sessions[token] = {
    userId: user.id,
    userName: user.name,
    isAdmin: !!user.isAdmin,
    expires: Date.now() + config.sessionDays * 864e5,
  };
  save();
  return token;
}
export function getSession(token) {
  const s = token && state.sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { delete state.sessions[token]; save(); return null; }
  return s;
}
export function deleteSession(token) {
  if (state.sessions[token]) { delete state.sessions[token]; save(); }
}
export function pruneSessions() {
  const t = Date.now();
  let changed = false;
  for (const [k, s] of Object.entries(state.sessions)) if (s.expires < t) { delete state.sessions[k]; changed = true; }
  if (changed) save();
}

// ---------- Requests ----------
// request: { id, userId, userName, artistMbid, artistName, monitorNew, status, createdAt, updatedAt,
//            lidarrArtistId, artistAddedByUs, note, items: [{ mbid, title, type, year, status, lidarrAlbumId, attempts, error, progress }] }

export function createRequest(data) {
  const req = {
    id: state.nextId++,
    createdAt: now(),
    updatedAt: now(),
    lidarrArtistId: null,
    note: '',
    ...data,
    items: data.items.map((i) => ({ lidarrAlbumId: null, attempts: 0, error: '', progress: null, ...i })),
  };
  state.requests.push(req);
  save();
  return req;
}
export function getRequest(id) {
  return state.requests.find((r) => r.id === Number(id)) || null;
}
export function listRequests({ userId } = {}) {
  const list = userId ? state.requests.filter((r) => r.userId === userId) : state.requests;
  return [...list].sort((a, b) => b.id - a.id);
}
// Called when a request's overall status changes – used for email notifications
const statusListeners = [];
export const onRequestStatus = (fn) => statusListeners.push(fn);

export function updateRequest(req, patch = {}) {
  const prev = req.status;
  Object.assign(req, patch, { updatedAt: now() });
  if ('status' in patch && patch.status !== prev) {
    for (const fn of statusListeners) {
      try { fn(req, prev); } catch (e) { console.error('[db] status listener failed:', e.message); }
    }
  }
  save();
  return req;
}
export function deleteRequest(id) {
  const idx = state.requests.findIndex((r) => r.id === Number(id));
  if (idx >= 0) { state.requests.splice(idx, 1); save(); }
}
// Latest status per release group (for showing badges in search/artist page)
export function itemStatusMap() {
  const map = new Map();
  for (const r of [...state.requests].sort((a, b) => a.id - b.id)) {
    for (const i of r.items) {
      if (i.status === 'declined') continue;
      map.set(i.mbid, { status: i.status, requestId: r.id, progress: i.progress });
    }
  }
  return map;
}

// ---------- User preferences (keyed by Emby user ID) ----------
// { name, email, notify: boolean, events: [status, ...] }
export function getUser(userId) {
  return state.users[userId] || null;
}
export function setUser(userId, patch) {
  state.users[userId] = { ...(state.users[userId] || {}), ...patch, updatedAt: now() };
  save();
  return state.users[userId];
}
