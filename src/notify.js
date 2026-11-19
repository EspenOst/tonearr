// Email notifications: admins hear about requests that need approval,
// users hear about the statuses they chose for their own requests.
import { config } from './config.js';
import * as db from './db.js';
import { sendMail } from './mailer.js';
import { isEmailEnabled, adminEmailList } from './settings.js';

/** Statuses a user can be notified about, in the order they usually happen. */
export const EVENTS = {
  approved: 'Approved by an administrator',
  declined: 'Declined by an administrator',
  downloading: 'Download started',
  downloaded: 'Downloaded – waiting for Emby to pick it up',
  partial: 'Partly available on the server',
  available: 'Available on the server',
  failed: 'Failed',
};
export const DEFAULT_EVENTS = ['approved', 'declined', 'partial', 'available', 'failed'];

const smtp = () => ({
  host: config.smtpHost,
  port: config.smtpPort,
  security: config.smtpSecurity,
  user: config.smtpUser,
  password: config.smtpPassword,
});
const appName = () => config.appName || 'Tonearr';
const link = (hash) => (config.appUrl ? `${config.appUrl}/${hash}` : '');

// One message at a time – keeps it gentle on the mail server and the log readable
let chain = Promise.resolve();
function queue(to, subject, text) {
  chain = chain.then(async () => {
    try {
      await sendMail(smtp(), { from: config.emailFrom, to, subject: `[${appName()}] ${subject}`, text });
      console.log(`[email] Sent "${subject}" to ${to}`);
    } catch (e) {
      console.error(`[email] Could not send "${subject}" to ${to}: ${e.message}`);
    }
  });
  return chain;
}

const albumList = (items) => items.map((i) => `  • ${i.title}${i.year ? ` (${i.year})` : ''}`).join('\n');
const footer = (text) => `${text}\n\n–\nThis email was sent by ${appName()}.${config.appUrl ? ` Change which emails you get under Notifications: ${link('#/notifications')}` : ''}\n`;

/** A user's request needs approval – tell the admins. */
export function newPendingRequest(req) {
  if (!isEmailEnabled()) return;
  const n = req.items.length;
  const subject = `${req.userName} requested ${req.artistName} – needs approval`;
  const text = `${req.userName} has requested ${n} ${n === 1 ? 'release' : 'releases'} by ${req.artistName}:\n\n${albumList(req.items)}\n\n`
    + (config.appUrl ? `Approve or decline it here: ${link('#/requests')}\n` : 'Approve or decline it under Requests in Tonearr.\n')
    + `\n–\nYou get this because your address is listed under Settings → Email notifications in ${appName()}.\n`;
  for (const to of adminEmailList()) queue(to, subject, text);
}

/** Which notification a status change means, if any. */
function eventFor(req, prev) {
  if (req.status === 'processing' && (prev === 'pending' || prev === 'declined')) return 'approved';
  return EVENTS[req.status] ? req.status : null;
}

function messageFor(event, req) {
  const a = req.artistName;
  const items = req.items;
  const n = items.length;
  const what = n === 1 ? `${items[0].title} by ${a}` : `${n} releases by ${a}`;
  const available = items.filter((i) => i.status === 'available');
  const failed = items.filter((i) => i.status === 'failed');
  switch (event) {
    case 'approved':
      return [`Approved: ${what}`, `Your request for ${what} has been approved and sent to Lidarr for download.\n\n${albumList(items)}`];
    case 'declined':
      return [`Declined: ${what}`, `Your request for ${what} was declined by an administrator.${req.note ? `\n\nNote: ${req.note}` : ''}\n\n${albumList(items)}`];
    case 'downloading':
      return [`Downloading: ${what}`, `Lidarr has started downloading ${what}.\n\n${albumList(items)}`];
    case 'downloaded':
      return [`Downloaded: ${what}`, `${what} has been downloaded. It will be available as soon as Emby has scanned the library.\n\n${albumList(items)}`];
    case 'partial':
      return [`Partly available: ${a}`, `Some of what you requested by ${a} is now available on the server:\n\n${albumList(available)}\n\nThe rest is still on its way.`];
    case 'available':
      return [`Available: ${what}`, `${what} is now available on the server – open Emby to listen.\n\n${albumList(items)}`];
    case 'failed':
      return [`Failed: ${what}`, `Tonearr could not get ${what}.\n\n${(failed.length ? failed : items).map((i) => `  • ${i.title}${i.error ? ` – ${i.error}` : ''}`).join('\n')}${req.error ? `\n\n${req.error}` : ''}\n\nYou can try again under Requests.`];
  }
  return null;
}

/** Hooked into db.updateRequest – runs whenever a request's overall status changes. */
function onStatus(req, prev) {
  const event = eventFor(req, prev);
  if (!event || !isEmailEnabled()) return;
  // Each kind of notification at most once per request (statuses can bounce between downloading/downloaded)
  req.notified ||= [];
  if (req.notified.includes(event)) return;
  const user = db.getUser(req.userId);
  if (!user?.notify || !user.email || !(user.events || DEFAULT_EVENTS).includes(event)) return;
  req.notified.push(event);
  const [subject, body] = messageFor(event, req);
  const open = config.appUrl ? `\n\nSee the request: ${link('#/requests')}` : '';
  queue(user.email, subject, footer(`Hi ${req.userName},\n\n${body}${open}`));
}
db.onRequestStatus(onStatus);

/** Sends a test message straight away and throws if it fails (used by the "Send test email" buttons). */
export async function sendTest(smtpSettings, from, to) {
  await sendMail(smtpSettings, {
    from,
    to,
    subject: `[${appName()}] Test email`,
    text: `This is a test email from ${appName()}. If you can read this, email notifications work.\n`,
  });
}
