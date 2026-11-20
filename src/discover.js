// Discover page: suggestions based on what is already on the server.
//  - New and upcoming releases: ListenBrainz' "fresh releases" (one call covers every artist),
//    filtered locally down to artists in Emby, in Lidarr or requested here.
//  - Popular now: the most played release groups on ListenBrainz this month.
//  - Missing from the collection: the best-known studio albums by artists on the server, measured by
//    how many editions MusicBrainz has of each. Looked up per artist in the background (at low
//    priority, so searches go first) and cached in data/artist-albums.json.
//  - For each user: missing albums by the artists they play most in Emby, and the best-known albums
//    by similar artists that aren't on the server (ListenBrainz' similar artists, cached in
//    data/similar-artists.json). Play counts never leave the server – only artist IDs are looked up.
// Release types come from MusicBrainz (ListenBrainz only gives the primary type, or none at all).
// ListenBrainz' per-artist popularity would be better, but it needs an auth token.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, errorReason } from './config.js';
import * as db from './db.js';
import * as emby from './emby.js';
import * as lidarr from './lidarr.js';
import * as mb from './musicbrainz.js';
import { isLidarrConfigured, isSetupRequired } from './settings.js';

const LB = 'https://api.listenbrainz.org/1/';
const LB_LABS = 'https://labs.api.listenbrainz.org/';
const SIMILAR_ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
const WINDOW_DAYS = 90; // fresh releases, both back and forward from today (the API's maximum)
const RETRY_AFTER = 30 * 60 * 1000; // wait this long after a failed fetch
const LIDARR_TTL = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Albums and EPs, including live albums and soundtracks. Singles are left out: they are most of
// what comes out each week, and usually end up on an album anyway.
const PRIMARY = new Set(['Album', 'EP']);
const SECONDARY = new Set(['', 'Live', 'Soundtrack']);
const wanted = (rg) => PRIMARY.has(rg.primaryType) && rg.secondaryTypes.every((s) => SECONDARY.has(s));

async function lbGet(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': config.mbUserAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    throw new Error(`Cannot reach ListenBrainz (${errorReason(e)})`);
  }
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`ListenBrainz responded ${res.status}`);
  return res.json();
}

/**
 * A list fetched now and then. get() starts a fetch in the background when the list is stale.
 * With wait, the first call waits for it; without, it returns null until the list is ready.
 */
function cachedList(name, fetcher, ttl) {
  const s = { value: null, at: 0, error: '', loading: null, lastAttempt: 0 };
  const refresh = () => {
    if (s.loading) return s.loading;
    s.lastAttempt = Date.now();
    s.loading = fetcher()
      .then((value) => {
        Object.assign(s, { value, at: Date.now(), error: '' });
        console.log(`[discover] ${name}: ${value.length} albums`);
      })
      .catch((e) => {
        s.error = e.message;
        console.error(`[discover] ${name}: ${e.message}`);
      })
      .finally(() => { s.loading = null; });
    return s.loading;
  };
  return {
    refresh,
    async get({ wait = false } = {}) {
      const now = Date.now();
      if (now - s.at > ttl && now - s.lastAttempt > RETRY_AFTER) refresh();
      if (!s.at && s.loading && wait) await s.loading;
      if (s.at) return s.value;
      if (s.loading) return null;
      throw new Error(s.error || 'Not loaded yet');
    },
  };
}

/** Per-artist data kept in a JSON file in the data directory: { artists: { mbid: { at, ... } } } */
function artistStore(name, ttl) {
  const file = path.join(config.dataDir, name);
  const store = { artists: {} };
  if (existsSync(file)) {
    try {
      store.artists = JSON.parse(readFileSync(file, 'utf8')).artists || {};
    } catch (e) {
      console.error(`[discover] Could not read ${name}: ${e.message}`);
    }
  }
  store.stale = (mbid) => !(Date.now() - (store.artists[mbid]?.at || 0) < ttl);
  store.save = () => {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify({ artists: store.artists }));
      renameSync(tmp, file);
    } catch (e) {
      console.error(`[discover] Could not save ${file} (${e.code || e.message})`);
    }
  };
  return store;
}

// ---------- New and upcoming ----------
const fresh = cachedList('new and upcoming releases', async () => {
  const data = await lbGet(`${LB}explore/fresh-releases/?days=${WINDOW_DAYS}&past=true&future=true`);
  // One entry per release group, with its earliest release date
  const byGroup = new Map();
  for (const r of data?.payload?.releases || []) {
    const primaryType = r.release_group_primary_type || '';
    const secondaryTypes = r.release_group_secondary_type ? [r.release_group_secondary_type] : [];
    if (!wanted({ primaryType, secondaryTypes })) continue;
    if (!r.release_group_mbid || !r.release_date || !r.artist_mbids?.length) continue;
    const mbid = r.release_group_mbid.toLowerCase();
    const prev = byGroup.get(mbid);
    if (prev && prev.date <= r.release_date) continue;
    byGroup.set(mbid, {
      mbid,
      title: r.release_name,
      date: r.release_date,
      year: Number(r.release_date.slice(0, 4)) || null,
      primaryType,
      secondaryTypes,
      type: mb.typeLabel(primaryType, secondaryTypes),
      artistCredit: r.artist_credit_name || '',
      artistMbids: r.artist_mbids.map((m) => m.toLowerCase()),
    });
  }
  return [...byGroup.values()];
}, 6 * 3600 * 1000);

// ---------- Popular now ----------
const popular = cachedList('popular now', async () => {
  const data = await lbGet(`${LB}stats/sitewide/release-groups?range=month&count=100`);
  // The list has one row per release, so the same release group can show up more than once
  const ids = [...new Set((data?.payload?.release_groups || []).map((r) => r.release_group_mbid?.toLowerCase()).filter(Boolean))];
  const info = await mb.lookupReleaseGroups(ids);
  // One album per artist, otherwise a few big artists fill the whole row
  const artists = new Set();
  return ids.map((id) => info.get(id)).filter((rg) => {
    if (!rg?.artist || !wanted(rg) || artists.has(rg.artist.mbid)) return false;
    artists.add(rg.artist.mbid);
    return true;
  });
}, 24 * 3600 * 1000);

// ---------- "Your" artists ----------
let lidarrArtists = { map: new Map(), at: 0 };

async function lidarrArtistMap() {
  if (!isLidarrConfigured()) return new Map();
  if (Date.now() - lidarrArtists.at < LIDARR_TTL) return lidarrArtists.map;
  try {
    const list = await lidarr.listArtists();
    lidarrArtists = { map: new Map(list.filter((a) => a.foreignArtistId).map((a) => [a.foreignArtistId.toLowerCase(), a.artistName])), at: Date.now() };
  } catch (e) {
    console.error(`[discover] Could not read artists from Lidarr: ${e.message}`);
    lidarrArtists.at = Date.now(); // don't retry on every page view
  }
  return lidarrArtists.map;
}

/** MBID -> name for every artist in Emby, in Lidarr or in a request that wasn't declined. */
async function knownArtists(idx) {
  const map = new Map(await lidarrArtistMap());
  for (const r of db.listRequests()) {
    if (r.status !== 'declined' && r.artistMbid) map.set(r.artistMbid.toLowerCase(), r.artistName);
  }
  for (const [mbid, info] of idx?.artists || []) map.set(mbid, info.name);
  return map;
}

/**
 * Artists whose missing albums we suggest, most relevant first: artists requested here (newest
 * first), then artists with albums in Emby (most albums first). Artists that only appear on
 * other people's tracks are left out.
 */
const MAX_ARTISTS = 300;
function collectionArtists(idx) {
  const out = new Map();
  for (const r of db.listRequests()) {
    const mbid = r.artistMbid?.toLowerCase();
    if (r.status !== 'declined' && mbid && !out.has(mbid)) out.set(mbid, { mbid, name: r.artistName });
  }
  const inEmby = [...(idx?.artists || [])]
    .map(([mbid, info]) => ({ mbid, name: info.name, albums: idx.albumsByArtist?.get(emby.norm(info.name)) || 0 }))
    .filter((a) => a.albums > 0)
    .sort((a, b) => b.albums - a.albums);
  for (const a of inEmby) if (!out.has(a.mbid)) out.set(a.mbid, { mbid: a.mbid, name: a.name });
  return [...out.values()].filter((a) => !mb.isBlockedArtist(a.mbid, a.name)).slice(0, MAX_ARTISTS);
}

// ---------- Best-known albums per artist ----------
const MIN_SHARE = 0.2; // an album needs at least 20% of the editions of the artist's best-known album
const PER_ARTIST = 8;
const MAX_MATCHES = 100; // more studio albums than this (classical composers etc.): no reliable ranking

// artists: mbid -> { at, albums: [release group + releases (number of editions)] }
const albumStore = artistStore('artist-albums.json', 30 * 864e5);

async function lookUpAlbums(artist) {
  const { total, albums } = await mb.artistStudioAlbums(artist.mbid);
  // Only albums where this artist is the main artist – not collaborations credited to someone else first
  const own = total > MAX_MATCHES ? [] : albums.filter((a) => a.artist?.mbid === artist.mbid);
  const top = Math.max(0, ...own.map((a) => a.releases));
  albumStore.artists[artist.mbid] = {
    at: Date.now(),
    albums: own
      .filter((a) => top && a.releases >= top * MIN_SHARE)
      .sort((a, b) => b.releases - a.releases)
      .slice(0, PER_ARTIST),
  };
}

// One background job looks up albums: first artists someone is waiting for (urgent: the artists
// a user plays and their similar artists), then the rest of the collection.
const job = { running: false, timer: null, urgent: new Map() };
function scheduleArtists(ms) {
  clearTimeout(job.timer);
  job.timer = setTimeout(runArtists, ms);
}

function needAlbums(artists) {
  let added = false;
  for (const a of artists) {
    if (!albumStore.stale(a.mbid) || job.urgent.has(a.mbid) || mb.isBlockedArtist(a.mbid, a.name)) continue;
    job.urgent.set(a.mbid, a);
    added = true;
  }
  if (added && !job.running) scheduleArtists(500);
}

function takeUrgent() {
  const [first] = job.urgent.values();
  if (first) job.urgent.delete(first.mbid);
  return first;
}

async function runArtists() {
  if (job.running) return;
  if (isSetupRequired()) return scheduleArtists(RETRY_AFTER);
  job.running = true;
  let done = 0;
  try {
    const idx = await emby.getIndex().catch(() => null);
    const rest = collectionArtists(idx).filter((a) => albumStore.stale(a.mbid));
    if (rest.length || job.urgent.size) console.log(`[discover] Looking up the best-known albums for ${rest.length + job.urgent.size} artist(s)`);
    for (let a; (a = takeUrgent() || rest.shift());) {
      if (!albumStore.stale(a.mbid)) continue;
      await lookUpAlbums(a); // MusicBrainz' rate limit paces this
      if (++done % 10 === 0) albumStore.save();
    }
    if (done) console.log(`[discover] Best-known albums: ${done} artist(s) done`);
  } catch (e) {
    console.error(`[discover] Best-known albums: stopped after ${done} artist(s): ${e.message}`);
  } finally {
    if (done) albumStore.save();
    job.running = false;
    // New artists (requests, library) are picked up on the next round; anything that became urgent
    // after a failure waits as well
    scheduleArtists(RETRY_AFTER);
  }
}

// ---------- Similar artists ----------
const SIMILAR_PER_ARTIST = 30;
// artists: mbid -> { at, similar: [{ mbid, name, score }] }
const similarStore = artistStore('similar-artists.json', 30 * 864e5);
let similarJob = null;

async function lookUpSimilar(artist) {
  const data = await lbGet(`${LB_LABS}similar-artists/json?artist_mbids=${artist.mbid}&algorithm=${SIMILAR_ALGORITHM}`);
  similarStore.artists[artist.mbid] = {
    at: Date.now(),
    similar: (Array.isArray(data) ? data : [])
      .filter((r) => UUID.test(r.artist_mbid || '') && !mb.isBlockedArtist(r.artist_mbid, r.name))
      .slice(0, SIMILAR_PER_ARTIST)
      .map((r) => ({ mbid: r.artist_mbid, name: r.name, score: r.score || 0 })),
  };
}

/** Looks up similar artists in the background, then queues their albums. */
function needSimilar(artists) {
  const todo = artists.filter((a) => similarStore.stale(a.mbid));
  if (!todo.length || similarJob || !config.listenbrainzEnabled) return;
  similarJob = (async () => {
    let done = 0;
    try {
      for (const a of todo) {
        await lookUpSimilar(a);
        done++;
        await sleep(500); // be gentle – ListenBrainz has no documented limit for this
      }
    } catch (e) {
      console.error(`[discover] Similar artists: stopped after ${done} artist(s): ${e.message}`);
    }
    if (done) {
      similarStore.save();
      console.log(`[discover] Similar artists: ${done} artist(s) done`);
      // Queue the albums of the new suggestions, so they are ready on the next visit
      const idx = await emby.getIndex().catch(() => null);
      const known = await knownArtists(idx);
      for (const p of profiles.values()) if (p.artists) needAlbums(similarTo(p, known));
    }
    return done;
  })().catch(() => 0).then((done) => {
    // After a failure, wait before trying again
    setTimeout(() => { similarJob = null; }, done ? 0 : RETRY_AFTER);
  });
}

// ---------- What each user plays ----------
const PROFILE_TTL = 6 * 3600 * 1000;
const TOP_ARTISTS = 25;
const SIMILAR_FROM = 10; // similar artists are looked up for this many of a user's top artists
const MAX_SIMILAR = 40;
const DIVERSITY = 0.75;
const profiles = new Map(); // Emby user id -> { at, artists: [{ mbid, name, score }], loading }

// Plays count double when recent; favourites add to the artist's score
function score(a) {
  return a.plays + a.recentPlays + (a.favourite ? 25 : 0) + a.favouriteAlbums * 10 + a.favouriteTracks * 3;
}

async function buildProfile(userId) {
  const idx = await emby.getIndex();
  const listening = await emby.listening(userId, idx);
  const artists = [...listening.values()]
    .filter((a) => !mb.isBlockedArtist(a.mbid, a.name))
    .map((a) => ({ mbid: a.mbid, name: a.name, score: score(a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_ARTISTS);
  return { at: Date.now(), artists };
}

/** The user's profile. Waits the first time; after that a stale one is used while it is rebuilt. */
async function profileFor(userId) {
  const p = profiles.get(userId);
  if (p && (p.loading || Date.now() - p.at < PROFILE_TTL)) return p.artists ? p : p.loading;
  const loading = buildProfile(userId)
    .catch((e) => {
      console.error(`[discover] Could not read what the user plays in Emby: ${e.message}`);
      return { at: Date.now() - PROFILE_TTL + RETRY_AFTER, artists: [] };
    })
    .then((np) => { profiles.set(userId, np); return np; });
  profiles.set(userId, { ...p, loading });
  return p?.artists ? p : loading;
}

/**
 * Artists similar to the user's top artists that aren't in Emby, Lidarr or a request. Artists
 * similar to several of them, or to the ones played most, come first.
 */
function similarTo(profile, known) {
  const top = profile.artists.slice(0, SIMILAR_FROM);
  const best = top[0]?.score || 1;
  const out = new Map();
  for (const src of top) {
    const list = similarStore.artists[src.mbid]?.similar;
    if (!list?.length) continue;
    const weight = Math.sqrt(src.score / best);
    for (const s of list) {
      if (known.has(s.mbid) || s.mbid === src.mbid) continue;
      const add = weight * (s.score / (list[0].score || 1));
      const c = out.get(s.mbid) || { mbid: s.mbid, name: s.name, score: 0, because: src.name, best: 0 };
      c.score += add;
      if (add > c.best) Object.assign(c, { best: add, because: src.name });
      out.set(s.mbid, c);
    }
  }
  // Each pick from the same source artist counts a bit less, so one favourite doesn't fill the row
  const left = [...out.values()];
  const picked = new Map();
  const result = [];
  const effective = (c) => c.score * DIVERSITY ** (picked.get(c.because) || 0);
  while (left.length && result.length < MAX_SIMILAR) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (effective(left[i]) > effective(left[best])) best = i;
    const [c] = left.splice(best, 1);
    picked.set(c.because, (picked.get(c.because) || 0) + 1);
    result.push(c);
  }
  return result;
}

/**
 * The first albums in `artists` order that aren't on the server or requested: one per artist,
 * then a second round if there is room. `annotate` sets .status like everywhere else.
 */
function pickAlbums(artists, annotate, limit, rounds = 1) {
  const lists = artists.map((artist) => {
    const albums = albumStore.artists[artist.mbid]?.albums || [];
    // Our own spelling of the name, so matching against Emby and the request use the same one
    const list = annotate(albums.map(({ releases, ...a }) => ({ ...a, artist: { mbid: artist.mbid, name: artist.name } })));
    return list.filter((a) => !a.status).map((a) => (artist.because ? { ...a, because: artist.because } : a));
  });
  const out = [];
  for (let round = 0; round < rounds; round++) {
    for (const list of lists) if (list[round] && out.length < limit) out.push(list[round]);
  }
  return out;
}

/**
 * The user's two shelves: missing albums by the artists they play most, and albums by similar
 * artists not on the server. Null when the user hasn't played anything yet.
 * `pending` means suggestions are still being looked up.
 */
export async function personalShelves(userId, idx, annotate, limit) {
  const profile = await profileFor(userId);
  if (!profile.artists.length) return null;
  needAlbums(profile.artists);
  const yours = pickAlbums(profile.artists, annotate, limit, 2);
  const shelves = { yours: { items: yours, pending: !yours.length && profile.artists.some((a) => albumStore.stale(a.mbid)) } };
  if (config.listenbrainzEnabled) {
    const sources = profile.artists.slice(0, SIMILAR_FROM);
    needSimilar(sources);
    const similar = similarTo(profile, await knownArtists(idx));
    needAlbums(similar);
    const items = pickAlbums(similar, annotate, limit);
    const waiting = sources.some((a) => similarStore.stale(a.mbid)) || similar.some((a) => albumStore.stale(a.mbid));
    shelves.similar = { items, pending: !items.length && waiting };
  }
  return shelves;
}

/** Called at startup and when settings change, so the first visit doesn't have to wait. */
export function warmUp() {
  scheduleArtists(5000);
  if (!config.listenbrainzEnabled) return;
  fresh.get().catch(() => {});
  popular.get().catch(() => {});
}

// ---------- Shelves ----------
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/**
 * New (last 90 days, newest first) and upcoming (soonest first) albums whose main artist is one of ours.
 * Returns null when ListenBrainz is switched off.
 */
export async function releaseShelves(idx) {
  if (!config.listenbrainzEnabled) return null;
  const [releases, artists] = await Promise.all([fresh.get({ wait: true }), knownArtists(idx)]);
  const t = today();
  const newReleases = [];
  const upcoming = [];
  for (const r of releases || []) {
    // Only the main artist counts – guest appearances would fill the list with other people's albums
    const main = r.artistMbids[0];
    const name = artists.get(main);
    if (!name || mb.isBlockedArtist(main, name)) continue;
    const { artistMbids, ...item } = r;
    item.artist = { mbid: main, name };
    (r.date <= t ? newReleases : upcoming).push(item);
  }
  newReleases.sort((a, b) => b.date.localeCompare(a.date));
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  return { newReleases, upcoming };
}

/** The most played albums on ListenBrainz this month. Null when switched off or still loading. */
export async function popularNow() {
  if (!config.listenbrainzEnabled) return null;
  const list = await popular.get();
  return list && list.map((rg) => ({ ...rg }));
}

/**
 * One album per artist on the server: their best-known album that isn't on the server or requested.
 * Albums with the most editions come first, so classics go before an obscure artist's only album.
 */
export function missingFromCollection(idx, annotate, limit) {
  const out = [];
  collectionArtists(idx).forEach((artist, rank) => {
    const albums = albumStore.artists[artist.mbid]?.albums;
    if (!albums?.length) return;
    const list = annotate(albums.map((a) => ({ ...a, artist: { mbid: artist.mbid, name: artist.name } })));
    const pick = list.find((a) => !a.status);
    if (pick) out.push({ ...pick, rank });
  });
  out.sort((a, b) => b.releases - a.releases || a.rank - b.rank);
  return out.slice(0, limit).map(({ rank, releases, ...a }) => a);
}

/** The latest albums other users have requested. */
export function requestedByOthers(userId, limit) {
  const seen = new Set();
  const out = [];
  for (const r of db.listRequests()) {
    if (r.userId === userId || r.status === 'declined') continue;
    for (const i of r.items) {
      if (i.status === 'declined' || seen.has(i.mbid)) continue;
      seen.add(i.mbid);
      out.push({ mbid: i.mbid, title: i.title, type: i.type, year: i.year, artist: { mbid: r.artistMbid, name: r.artistName }, artistCredit: r.artistName });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
