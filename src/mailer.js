// Minimal SMTP client (no dependencies): STARTTLS, implicit TLS (port 465) or plain,
// AUTH PLAIN/LOGIN, UTF-8 text messages. Enough for Gmail, Outlook, ISPs and local relays.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

const TIMEOUT_MS = 20_000;

/** "Name <a@b.c>" or "a@b.c" → { name, address } */
export function parseAddress(s) {
  const str = String(s || '').trim();
  const m = str.match(/^(.*)<([^<>]+)>\s*$/);
  const name = m ? m[1].trim().replace(/^"|"$/g, '') : '';
  const address = (m ? m[2] : str).trim();
  return { name, address };
}
export const isEmail = (s) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(String(s || ''));

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// RFC 2047 – non-ASCII header text (subject, display names)
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const formatAddress = ({ name, address }) => (name ? `${/^[\w .-]*$/.test(name) ? `"${name}"` : encodeWord(name)} <${address}>` : address);
const ehloName = () => (os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost');

function buildMessage({ from, to, subject, text }) {
  const domain = from.address.split('@')[1] || 'localhost';
  const body = b64(text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n'); // base64 never starts a line with "."
  return [
    `From: ${formatAddress(from)}`,
    `To: ${formatAddress(to)}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

/** Reads SMTP replies (multi-line "250-..." continues until "250 ..."). */
class Connection {
  constructor() {
    this.replies = [];
    this.waiting = null;
    this.lines = [];
    this.buf = '';
    this.error = null;
  }
  attach(socket) {
    if (this.socket) this.socket.removeAllListeners('data');
    this.socket = socket;
    socket.setTimeout(TIMEOUT_MS, () => { this.fail(new Error('the mail server stopped responding (timed out)')); socket.destroy(); });
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('the mail server closed the connection')));
  }
  onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)), text: line };
        this.lines = [];
        if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(reply); } else this.replies.push(reply);
      }
    }
  }
  fail(e) {
    if (this.error || this.closed) return;
    this.error = e;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(e); }
  }
  read() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }
  /** Sends a line and checks the reply code's first digit (2 = OK, 3 = continue). */
  async cmd(line, expect = '2', shown = line) {
    if (line != null) this.socket.write(line + '\r\n');
    const r = await this.read();
    if (String(r.code)[0] !== expect) {
      const step = String(shown || '').split(/[ :]/)[0];
      const what = { MAIL: 'The mail server refused the sender address', RCPT: 'The mail server refused the recipient', Message: 'The mail server refused the message', Greeting: 'The mail server refused the connection' }[step];
      const err = new Error(what ? `${what} (${r.text})` : `${step ? step + ': ' : ''}${r.text}`);
      err.smtpCode = r.code;
      throw err;
    }
    return r;
  }
  close() {
    this.closed = true;
    try { this.socket.write('QUIT\r\n'); } catch {}
    setTimeout(() => this.socket.destroy(), 500).unref();
  }
}

function connect(host, port, secure) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: net.isIP(host) ? undefined : host };
    const socket = secure ? tls.connect(opts) : net.connect(opts);
    const onErr = (e) => reject(e);
    socket.once('error', onErr);
    socket.setTimeout(TIMEOUT_MS, () => { socket.destroy(); reject(new Error('timed out')); });
    socket.once(secure ? 'secureConnect' : 'connect', () => { socket.removeListener('error', onErr); socket.setTimeout(0); resolve(socket); });
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: net.isIP(host) ? undefined : host });
    s.once('error', reject);
    s.once('secureConnect', () => { s.removeListener('error', reject); resolve(s); });
  });
}

function certError(e, host) {
  const code = e?.code || '';
  if (!/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return null;
  const hint = /ALTNAME/.test(code)
    ? 'Use the host name the certificate is issued for (e.g. smtp.example.com), not an IP address'
    : 'The server probably uses a self-signed certificate, which Tonearr does not accept';
  return new Error(`The mail server's certificate is not trusted for ${host} (${code}). ${hint}`);
}

const capabilities = (reply) => reply.lines.map((l) => l.toUpperCase());

/**
 * Sends one message. smtp = { host, port, security: 'starttls'|'tls'|'none', user, password }.
 * Throws an Error with a readable message on failure.
 */
export async function sendMail(smtp, { from, to, subject, text }) {
  const sender = parseAddress(from);
  const rcpt = parseAddress(to);
  if (!isEmail(sender.address)) throw new Error(`Invalid sender address: ${from}`);
  if (!isEmail(rcpt.address)) throw new Error(`Invalid recipient address: ${to}`);
  const port = Number(smtp.port) || (smtp.security === 'tls' ? 465 : 587);

  let socket;
  try {
    socket = await connect(smtp.host, port, smtp.security === 'tls');
  } catch (e) {
    throw certError(e, smtp.host) || new Error(`Cannot reach the mail server ${smtp.host}:${port} (${e.code || e.message})`);
  }
  const c = new Connection();
  c.attach(socket);
  try {
    await c.cmd(null, '2', 'Greeting');
    let ehlo = await c.cmd(`EHLO ${ehloName()}`);
    if (smtp.security === 'starttls') {
      if (!capabilities(ehlo).some((l) => l.startsWith('STARTTLS'))) {
        throw new Error('The mail server does not offer STARTTLS – try SSL/TLS (port 465) or no encryption');
      }
      await c.cmd('STARTTLS');
      c.attach(await upgrade(socket, smtp.host));
      ehlo = await c.cmd(`EHLO ${ehloName()}`);
    }
    if (smtp.user) {
      const auth = capabilities(ehlo).find((l) => l.startsWith('AUTH')) || '';
      try {
        if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
          await c.cmd(`AUTH PLAIN ${b64(`\0${smtp.user}\0${smtp.password || ''}`)}`, '2', 'AUTH');
        } else {
          await c.cmd('AUTH LOGIN', '3');
          await c.cmd(b64(smtp.user), '3', 'AUTH');
          await c.cmd(b64(smtp.password || ''), '2', 'AUTH');
        }
      } catch (e) {
        throw new Error(`Sign-in to the mail server failed – check the username and password (${e.message.replace(/^AUTH: /, '')})`);
      }
    }
    await c.cmd(`MAIL FROM:<${sender.address}>`);
    await c.cmd(`RCPT TO:<${rcpt.address}>`);
    await c.cmd('DATA', '3');
    c.socket.write(buildMessage({ from: sender, to: rcpt, subject, text }) + '\r\n.\r\n');
    await c.cmd(null, '2', 'Message');
  } catch (e) {
    throw certError(e, smtp.host) || (e.smtpCode || e.message.startsWith('The mail') || e.message.startsWith('Sign-in') ? e : new Error(`Mail server error: ${e.code || e.message}`));
  } finally {
    c.close();
  }
}
