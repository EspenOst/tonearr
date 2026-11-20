import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The version lives in package.json only
const pkg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));

// Read .env in the project folder if it exists (simple parser, no dependencies)
const envFile = path.resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const env = (k, d = '') => (process.env[k] ?? d).trim();
const trimSlash = (u) => u.replace(/\/+$/, '');
const bool = (k, d) => {
  const v = env(k, String(d)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
};

export const config = {
  version: pkg.version,
  port: Number(env('PORT', '5056')),
  dataDir: env('DATA_DIR', path.resolve(process.cwd(), 'data')),
  appName: env('APP_NAME', 'Tonearr'),

  embyUrl: trimSlash(env('EMBY_URL')),
  embyApiKey: env('EMBY_API_KEY'),

  lidarrUrl: trimSlash(env('LIDARR_URL')),
  lidarrApiKey: env('LIDARR_API_KEY'),
  lidarrRootFolder: env('LIDARR_ROOT_FOLDER'), // empty = first root folder in Lidarr
  lidarrQualityProfileId: Number(env('LIDARR_QUALITY_PROFILE_ID', '0')) || null,
  lidarrMetadataProfileId: Number(env('LIDARR_METADATA_PROFILE_ID', '0')) || null,

  // Requests from regular users are approved automatically (admins' requests are always auto-approved)
  autoApprove: bool('AUTO_APPROVE', true),

  // MusicBrainz requires an identifiable User-Agent. Consider adding contact info.
  mbUserAgent: env('MB_USER_AGENT', `Tonearr/${pkg.version} ( self-hosted music request app )`),

  // Discover: new and upcoming releases from ListenBrainz (only a public list is fetched – nothing is sent)
  listenbrainzEnabled: bool('LISTENBRAINZ_ENABLED', true),

  // Email notifications (off by default) – usually set up in the web UI
  emailEnabled: bool('EMAIL_ENABLED', false),
  smtpHost: env('SMTP_HOST'),
  smtpPort: Number(env('SMTP_PORT', '587')) || 587,
  smtpSecurity: env('SMTP_SECURITY', 'starttls'), // starttls | tls | none
  smtpUser: env('SMTP_USER'),
  smtpPassword: env('SMTP_PASSWORD'),
  emailFrom: env('EMAIL_FROM'), // "Tonearr <tonearr@example.com>"
  adminEmails: env('ADMIN_EMAILS'), // comma-separated; told about requests that need approval
  appUrl: trimSlash(env('APP_URL')), // used for links in emails

  sessionDays: Number(env('SESSION_DAYS', '30')),
  workerIntervalSec: Number(env('WORKER_INTERVAL_SEC', '30')),
  embyIndexTtlSec: Number(env('EMBY_INDEX_TTL_SEC', '300')),
};

export function checkConfig() {
  const missing = [];
  if (!config.embyUrl) missing.push('EMBY_URL');
  if (!config.embyApiKey) missing.push('EMBY_API_KEY');
  if (!config.lidarrUrl) missing.push('LIDARR_URL');
  if (!config.lidarrApiKey) missing.push('LIDARR_API_KEY');
  return missing;
}

/**
 * Node's fetch only says "fetch failed". The useful part (ENOTFOUND, ECONNREFUSED, ...) is in
 * e.cause – or one level deeper when both IPv4 and IPv6 were tried (AggregateError).
 */
export function errorReason(e) {
  if (e?.name === 'TimeoutError') return 'timed out';
  const c = e?.cause;
  return c?.code || c?.errors?.[0]?.code || c?.message || e?.message || String(e);
}
