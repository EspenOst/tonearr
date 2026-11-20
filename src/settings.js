// Settings saved from the web UI (data/settings.json).
// Environment variables are used as initial values; anything saved in the UI overrides them.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseAddress, isEmail } from './mailer.js';

mkdirSync(config.dataDir, { recursive: true });
const file = path.join(config.dataDir, 'settings.json');

const SECRET = ['embyApiKey', 'lidarrApiKey', 'smtpPassword'];
const FIELDS = {
  appName: 'string',
  embyUrl: 'url',
  embyApiKey: 'string',
  lidarrUrl: 'url',
  lidarrApiKey: 'string',
  lidarrRootFolder: 'string',
  lidarrQualityProfileId: 'id',
  lidarrMetadataProfileId: 'id',
  autoApprove: 'bool',
  mbUserAgent: 'string',
  listenbrainzEnabled: 'bool',
  emailEnabled: 'bool',
  smtpHost: 'host',
  smtpPort: 'port',
  smtpSecurity: ['starttls', 'tls', 'none'],
  smtpUser: 'string',
  smtpPassword: 'string',
  emailFrom: 'from',
  adminEmails: 'emails',
  appUrl: 'url',
};
const MASK = '••••';

const listeners = [];
export const onChange = (fn) => listeners.push(fn);

if (existsSync(file)) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const k of Object.keys(FIELDS)) if (k in saved) config[k] = saved[k];
  } catch (e) {
    console.error('[settings] Could not read settings.json:', e.message);
  }
}

// Setup = an Emby address is known, so users can sign in. The first admin to sign in sets it.
export const isSetupRequired = () => !config.embyUrl;
// The API key is needed to read the library (what's "Available"); sign-in works without it.
export const isEmbyConfigured = () => !!(config.embyUrl && config.embyApiKey);
export const isLidarrConfigured = () => !!(config.lidarrUrl && config.lidarrApiKey);
// Email is sent only when switched on and a server and sender are filled in
export const isEmailEnabled = () => !!(config.emailEnabled && config.smtpHost && config.emailFrom);
export const adminEmailList = () => splitEmails(config.adminEmails);

export const splitEmails = (v) => String(v || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

/** A validation error – shown to the admin as-is. */
export class InvalidSetting extends Error {}

/** What an admin still has to fill in under Settings. */
export function missingSettings() {
  const missing = [];
  if (!config.embyApiKey) missing.push('embyApiKey');
  if (!isLidarrConfigured()) missing.push('lidarr');
  return missing;
}

export const mask = (v) => (v ? MASK + String(v).slice(-4) : '');
/** Is this a masked value sent back from the client (= unchanged)? */
export const isMasked = (v) => typeof v === 'string' && v.startsWith(MASK);

export function normalizeUrl(v) {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'http://' + s); } catch { throw new Error(`Invalid address: ${s}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The address must start with http:// or https://');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** Settings as the client sees them (API keys masked). */
export function view() {
  const out = {};
  for (const k of Object.keys(FIELDS)) out[k] = SECRET.includes(k) ? mask(config[k]) : config[k] ?? '';
  if (config.smtpPassword) out.smtpPassword = MASK; // a password, unlike API keys, shouldn't reveal any characters
  return out;
}

/** Validates and saves changes. Returns a list of changed fields. */
export function save(patch) {
  const clean = {};
  for (const [k, type] of Object.entries(FIELDS)) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (SECRET.includes(k) && (!v || isMasked(v))) continue; // empty/masked = keep the saved key
    if (type === 'url') {
      try { v = normalizeUrl(v); } catch (e) { throw new InvalidSetting(e.message); }
    } else if (type === 'id') v = Number(v) || null;
    else if (type === 'bool') v = v === true || v === 'true';
    else if (type === 'port') {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 65535) throw new InvalidSetting('The mail server port must be a number between 1 and 65535');
    } else if (Array.isArray(type)) {
      if (!type.includes(v)) throw new InvalidSetting(`Invalid value for ${k}`);
    } else if (type === 'host') {
      v = String(v ?? '').trim().replace(/^smtps?:\/\//i, '').replace(/\/+$/, '');
      if (v && !/^[A-Za-z0-9.-]+$/.test(v)) throw new InvalidSetting(`Invalid mail server: ${v}`);
    } else if (type === 'from') {
      v = String(v ?? '').trim().slice(0, 300);
      if (v && !isEmail(parseAddress(v).address)) throw new InvalidSetting(`Invalid sender address: ${v} – use e.g. "Tonearr <tonearr@example.com>"`);
    } else if (type === 'emails') {
      const list = splitEmails(v);
      const bad = list.filter((x) => !isEmail(x));
      if (bad.length) throw new InvalidSetting(`Invalid email address: ${bad.join(', ')}`);
      v = list.join(', ');
    } else v = String(v ?? '').trim().slice(0, 500);
    clean[k] = v;
  }
  const enabled = 'emailEnabled' in clean ? clean.emailEnabled : config.emailEnabled;
  const pick = (k) => (k in clean ? clean[k] : config[k]);
  if (enabled && (!pick('smtpHost') || !pick('emailFrom'))) {
    throw new InvalidSetting('To turn on email notifications, fill in the mail server and the sender address');
  }
  const changed = Object.keys(clean).filter((k) => clean[k] !== config[k]);

  // Write to disk first, so a failed save doesn't leave settings that only exist in memory
  const persisted = {};
  for (const k of Object.keys(FIELDS)) persisted[k] = k in clean ? clean[k] : config[k];
  try {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    throw new Error(`Could not save the settings (${e.code || e.message}). The data folder must be writable by the container – see the server log`);
  }
  Object.assign(config, clean);

  if (changed.length) for (const fn of listeners) fn(changed);
  return changed;
}
