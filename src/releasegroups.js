// Some Emby albums are tagged with only a MusicBrainz release ID (one specific edition) and no
// release group ID. Tonearr works with release groups, so those albums would never match.
// This job looks up the release group for such albums in MusicBrainz in the background,
// in batches, and caches the answers in data/release-groups.json so each release is only
// looked up once.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { releaseGroupsForReleases } from './musicbrainz.js';

const file = path.join(config.dataDir, 'release-groups.json');
const BATCH = 50; // release IDs per MusicBrainz request (max 100; 50 keeps the URL short)
const RETRY_MISSING_MS = 7 * 864e5; // look up IDs MusicBrainz didn't know again after a week
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// found: releaseId -> releaseGroupId, missing: releaseId -> time of the last failed lookup
let store = { found: {}, missing: {} };
if (existsSync(file)) {
  try {
    store = { ...store, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    console.error('[release-groups] Could not read release-groups.json:', e.message);
  }
}

function persist() {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, file);
}

const job = { running: false, total: 0, done: 0, error: '' };

/** Adds the release groups we know about to an Emby index. */
export function applyTo(idx) {
  for (const { releaseId, info } of idx.releaseOnly) {
    const rg = store.found[releaseId];
    if (rg && !idx.releaseGroups.has(rg)) idx.releaseGroups.set(rg, info);
  }
}

/** Progress and results, shown to admins under Settings. */
export function stats(idx) {
  const list = idx?.releaseOnly || [];
  let matched = 0;
  let notFound = 0;
  for (const { releaseId } of list) {
    if (store.found[releaseId]) matched++;
    else if (store.missing[releaseId]) notFound++;
  }
  return { releaseOnly: list.length, matched, notFound, running: job.running, total: job.total, done: job.done, error: job.error };
}

/**
 * Looks up release IDs we don't know yet. Safe to call often: does nothing if a job is
 * already running or there's nothing to look up. `currentIndex` returns the latest index,
 * since the Emby index may be rebuilt while the job runs.
 */
export async function resolveInBackground(currentIndex) {
  if (job.running) return;
  const now = Date.now();
  const todo = [...new Set((currentIndex()?.releaseOnly || []).map((x) => x.releaseId))]
    .filter((id) => UUID.test(id) && !store.found[id] && !(store.missing[id] && now - store.missing[id] < RETRY_MISSING_MS));
  if (!todo.length) return;

  Object.assign(job, { running: true, total: todo.length, done: 0, error: '' });
  console.log(`[release-groups] Looking up ${todo.length} release(s) in MusicBrainz`);
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const result = await releaseGroupsForReleases(batch);
      for (const id of batch) {
        const rg = result.get(id);
        if (rg) {
          store.found[id] = rg;
          delete store.missing[id];
        } else {
          store.missing[id] = Date.now();
        }
      }
      persist();
      job.done += batch.length;
      const idx = currentIndex();
      if (idx) applyTo(idx);
    }
    const s = stats(currentIndex());
    console.log(`[release-groups] Done: ${s.matched} matched, ${s.notFound} not found in MusicBrainz`);
  } catch (e) {
    job.error = e.message;
    console.error('[release-groups] Lookup stopped:', e.message);
  } finally {
    job.running = false;
  }
}
