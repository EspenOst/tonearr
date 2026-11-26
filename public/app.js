// Tonearr – simple SPA with no build step
const $app = document.getElementById('app');
let me = null;
let pollTimer = null;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Signed out unexpectedly (e.g. the server restarted): fetch the setup status again, it may have changed
  if (res.status === 401 && path !== '/auth/login') { me = null; publicStatus = null; location.hash = '#/login'; throw new Error('Not signed in'); }
  if (!res.ok) throw new Error(data.error || `Error (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

const STATUS = {
  pending: 'Pending approval',
  approved: 'Approved',
  processing: 'Sent to Lidarr',
  waiting: 'Waiting for Lidarr',
  searching: 'Searching',
  downloading: 'Downloading',
  downloaded: 'Downloaded',
  partial: 'Partially available',
  available: 'Available',
  failed: 'Failed',
  declined: 'Declined',
};
const badge = (status, progress) =>
  status ? `<span class="badge ${esc(status)}">${esc(STATUS[status] || status)}${status === 'downloading' && progress != null ? ` ${progress}%` : ''}</span>` : '';

const TYPE_LABEL = { Album: 'Album', EP: 'EP', Single: 'Single', Compilation: 'Compilation', Live: 'Live', Soundtrack: 'Soundtrack', Remix: 'Remix', 'DJ-mix': 'DJ mix', 'Mixtape/Street': 'Mixtape', Demo: 'Demo', Other: 'Other' };
const typeLabel = (t) => TYPE_LABEL[t] || t || '';

function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function placeholder(name, cls = '') {
  const h = hue(name);
  const initials = String(name || '?').replace(/^the\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<div class="placeholder ${cls}" style="background:linear-gradient(135deg,hsl(${h},55%,35%),hsl(${(h + 50) % 360},60%,22%))">${esc(initials)}</div>`;
}
const coverUrl = (rgMbid, size = 250) => `https://coverartarchive.org/release-group/${encodeURIComponent(rgMbid)}/front-${size}`;
function cover(rgMbid, name, cls = 'cover') {
  return `<img class="${cls}" loading="lazy" src="${coverUrl(rgMbid)}" alt="" data-ph="${esc(name)}">`;
}
// Replace missing cover art with a colourful placeholder
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.ph) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = placeholder(img.dataset.ph, img.className.replace('cover', ''));
  img.replaceWith(tmp.firstElementChild);
}, true);

const fmtDate = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtLen = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}` : '');

const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  logout: '<svg viewBox="0 0 24 24" width="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5"><path d="M5 12.5 10 17 19 7"/></svg>',
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
};

// ---------- shell ----------
function shell(active, content) {
  const nav = [
    ['home', '#/', 'Discover', ICON.home],
    ['search', '#/search', 'Search', ICON.search],
    ['requests', '#/requests', 'Requests', ICON.list],
    ...(me.emailEnabled ? [['notifications', '#/notifications', 'Notifications', ICON.bell]] : []),
    ...(me.isAdmin ? [['settings', '#/settings', 'Settings', ICON.gear]] : []),
  ];
  return `
  <div class="shell">
    <aside class="sidebar">
      <a class="logo" href="#/"><img src="/icon.svg" alt=""><span>Tonearr</span></a>
      <nav class="nav">
        ${nav.map(([k, href, label, icon]) => `<a href="${href}" class="${active === k ? 'active' : ''}">${icon}<span>${label}</span></a>`).join('')}
      </nav>
      <div class="spacer"></div>
      <div class="userbox">
        <div class="avatar">${esc(me.name[0]?.toUpperCase())}</div>
        <div><div class="name">${esc(me.name)}</div><div class="role">${me.isAdmin ? 'Administrator' : 'User'}</div></div>
        <button class="icon-btn" id="logout" title="Sign out">${ICON.logout}</button>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <form class="searchbox" id="topsearch">${ICON.search}<input name="q" placeholder="Search for an artist, album or song…" autocomplete="off" value="${esc(currentQuery())}"></form>
      </div>
      ${setupNotice(active)}
      <div class="page" id="page">${content}</div>
    </div>
  </div>`;
}

// Shown to admins until Emby's API key and Lidarr have been filled in
const MISSING = {
  embyApiKey: 'the Emby API key is missing, so Tonearr can\'t see what is already in the library',
  lidarr: 'Lidarr is not connected, so requests can\'t be downloaded',
};
function setupNotice(active) {
  const missing = (me.missingSettings || []).filter((k) => MISSING[k]);
  if (!me.isAdmin || !missing.length) return '';
  const text = missing.map((k) => MISSING[k]).join('; ');
  return `<div class="notice"><span><b>Setup isn't finished:</b> ${esc(text.charAt(0).toUpperCase() + text.slice(1))}.</span>
    ${active === 'settings' ? '' : '<a class="btn sm primary" href="#/settings">Go to Settings</a>'}</div>`;
}

function currentQuery() {
  const [, qs = ''] = location.hash.split('?');
  return new URLSearchParams(qs).get('q') || '';
}
function currentType() {
  const [, qs = ''] = location.hash.split('?');
  return new URLSearchParams(qs).get('type') || 'artist';
}

function bindShell() {
  document.getElementById('logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    me = null;
    publicStatus = null;
    location.hash = '#/login';
  };
  document.getElementById('topsearch').onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) location.hash = `#/search?q=${encodeURIComponent(q)}&type=${currentType()}`;
  };
}

const page = () => document.getElementById('page');
const spinner = '<div class="spinner"></div>';
const empty = (msg) => `<div class="empty">${ICON.music}<div>${esc(msg)}</div></div>`;

// ---------- sign in ----------
// During first-time setup the form also asks for the Emby address, and only an Emby administrator gets in.
function renderLogin() {
  const setup = publicStatus?.setupRequired;
  $app.innerHTML = `
  <div class="login-wrap">
    <form class="login" id="loginform">
      <div class="logo"><img src="/icon.svg" alt=""><span>Tonearr</span></div>
      ${setup
        ? `<p class="muted"><b style="color:var(--text)">First-time setup.</b> Sign in with an Emby <b style="color:var(--text)">administrator</b> account. Tonearr uses this Emby server for all sign-ins.</p>
           <div class="field"><label for="e">Emby address</label><input id="e" name="embyUrl" placeholder="http://192.168.1.50:8096" required autofocus spellcheck="false">
             <div class="hint">Including the port. Use the LAN IP address, not localhost.</div></div>`
        : '<p class="muted">Sign in with your Emby account</p>'}
      <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required ${setup ? '' : 'autofocus'}></div>
      <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password"></div>
      <button class="btn primary" type="submit">Sign in</button>
      <div class="error-msg" id="loginerr"></div>
    </form>
  </div>`;
  document.getElementById('loginform').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    document.getElementById('loginerr').textContent = '';
    try {
      await api('/auth/login', { method: 'POST', body: { username: e.target.username.value, password: e.target.password.value, embyUrl: e.target.embyUrl?.value } });
      const d = await api('/me');
      me = d.user;
      // Straight to Settings after first-time setup – the API keys still need filling in
      location.hash = setup ? '#/settings' : '#/';
      publicStatus.setupRequired = false;
      router();
    } catch (err) {
      document.getElementById('loginerr').textContent = err.message;
      btn.disabled = false;
    }
  };
}

// ---------- discover / home ----------
const SHELVES = {
  new: ['New releases', 'From artists on the server, in Lidarr or requested here'],
  upcoming: ['Coming soon', 'Request now and Lidarr grabs it when it is out'],
  yours: ['More from artists you play', 'Based on what you listen to in Emby'],
  similar: ['You might like', 'Artists similar to the ones you play, not on the server yet'],
  missing: ['Missing from the collection', 'The best-known albums by artists on the server'],
  popular: ['Popular now', 'Most played on ListenBrainz this month'],
  others: ['Requested by others', ''],
};
const DATED_SHELVES = new Set(['new', 'upcoming']);

async function renderHome() {
  $app.innerHTML = shell('home', `
    <div class="welcome">
      <h1>Hi, ${esc(me.name)} 👋</h1>
      <div class="muted">Find artists and albums, and request them for the server.</div>
    </div>
    <div id="shelves">${spinner}</div>
    <div id="recent"></div>`);
  bindShell();
  const [discover, mine] = await Promise.allSettled([api('/discover'), api('/requests?scope=mine')]);
  if (!document.getElementById('shelves')) return; // the user has navigated away

  const $shelves = document.getElementById('shelves');
  $shelves.innerHTML = '';
  if (discover.status === 'rejected') $shelves.innerHTML = `<p class="muted small">${esc(discover.reason.message)}</p>`;
  for (const s of discover.value?.shelves || []) {
    if (!s.items.length && !s.error && !s.pending) continue;
    const [title, hint] = SHELVES[s.id] || [s.id, ''];
    const el = document.createElement('section');
    el.innerHTML = `
      <h2 class="shelf-head">${esc(title)}${hint ? ` <span class="count">${esc(hint)}</span>` : ''}</h2>
      ${s.error ? `<p class="muted small">Couldn't load this list: ${esc(s.error)}</p>`
        : !s.items.length ? '<p class="muted small">Finding suggestions – check back in a few minutes.</p>'
        : s.kind === 'artist' ? `<div class="shelf">${s.items.map(similarArtistCard).join('')}</div>`
        : `<div class="shelf">${s.items.map((a) => albumCard(a, { showArtist: true, showDate: DATED_SHELVES.has(s.id), linkArtist: true })).join('')}</div>`}`;
    $shelves.append(el);
    bindAlbumButtons(el, s.items);
  }

  const items = mine.status === 'fulfilled'
    ? mine.value.requests.flatMap((r) => r.items.map((i) => ({ ...i, artistName: r.artistName, artistMbid: r.artistMbid }))).slice(0, 24)
    : [];
  const hasShelves = !!$shelves.children.length;
  document.getElementById('recent').innerHTML = items.length
    ? `<h2>My recent requests</h2><div class="shelf">${items.map((i) => `
        <a class="card" href="#/artist/${esc(i.artistMbid)}">
          ${cover(i.mbid, i.title)}
          <div class="badge-slot">${badge(i.status, i.progress)}</div>
          <div class="body"><div class="title">${esc(i.title)}</div><div class="sub">${esc(i.artistName)}${i.year ? ' · ' + i.year : ''}</div></div>
        </a>`).join('')}</div>`
    : mine.status === 'rejected' ? empty(mine.reason.message)
    : hasShelves ? '' : empty('No requests yet. Search for an artist to get started!');
}

function similarArtistCard(a) {
  return `
    <a class="card artist-card" href="#/artist/${esc(a.mbid)}">
      ${a.image ? `<img class="round" loading="lazy" src="${esc(a.image)}" alt="" data-ph="${esc(a.name)}">` : placeholder(a.name, 'round')}
      <div class="title" title="${esc(a.name)}">${esc(a.name)}</div>
      <div class="sub" title="Similar to ${esc(a.because)}">Similar to ${esc(a.because)}</div>
    </a>`;
}

// "4 Dec", with the year only when it isn't this year
function fmtDay(iso) {
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d)) return '';
  const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) };
  return d.toLocaleDateString('en-GB', opts);
}

// ---------- search ----------
async function renderSearch() {
  const q = currentQuery();
  const type = currentType();
  const tab = (t, label) => `<a href="#/search?q=${encodeURIComponent(q)}&type=${t}" class="${type === t ? 'active' : ''}">${label}</a>`;
  $app.innerHTML = shell('search', `
    <h1>${q ? `Results for “${esc(q)}”` : 'Search'}</h1>
    <div class="tabs">${tab('artist', 'Artists')}${tab('album', 'Albums')}${tab('song', 'Songs')}</div>
    <div id="results">${q ? spinner : empty('Type a search in the box above.')}</div>`);
  bindShell();
  if (!q) { document.querySelector('#topsearch input').focus(); return; }
  const $r = document.getElementById('results');
  try {
    const { results } = await api(`/search?type=${type}&q=${encodeURIComponent(q)}`);
    if (currentQuery() !== q || currentType() !== type) return; // the user has navigated away
    if (!results.length) { $r.innerHTML = empty('No matches in MusicBrainz.'); return; }
    if (type === 'artist') {
      $r.innerHTML = `<div class="grid">${results.map((a) => `
        <a class="card artist-card" href="#/artist/${esc(a.mbid)}">
          ${placeholder(a.name, 'round')}
          <div class="title">${esc(a.name)}</div>
          <div class="sub">${esc([a.disambiguation, a.country, a.begin && (a.begin + (a.end ? '–' + a.end : ''))].filter(Boolean).join(' · ') || a.type || '&nbsp;')}</div>
          ${a.inLibrary ? '<span class="badge lib">On the server</span>' : ''}
        </a>`).join('')}</div>`;
    } else if (type === 'album') {
      $r.innerHTML = `<div class="grid">${results.map((a) => albumCard(a, { showArtist: true })).join('')}</div>`;
      bindAlbumButtons($r, results);
    } else {
      $r.innerHTML = `<div class="list">${results.map((s) => `
        <div class="row">
          ${s.album ? cover(s.album.mbid, s.album.title, 'thumb') : placeholder(s.title, 'thumb')}
          <div class="info">
            <div class="title">${esc(s.title)} <span class="muted small">${fmtLen(s.length)}</span></div>
            <div class="sub">${s.artist ? `<a href="#/artist/${esc(s.artist.mbid)}">${esc(s.artistCredit)}</a>` : esc(s.artistCredit)}
              ${s.album ? ` · from the ${esc(typeLabel(s.album.type)).toLowerCase()} <b>${esc(s.album.title)}</b>${s.album.year ? ' (' + s.album.year + ')' : ''}` : ''}</div>
          </div>
          <div class="right">
            ${s.album ? badge(s.album.status) : ''}
            ${s.album && s.artist && !s.album.status ? `<button class="btn sm primary" data-song="${esc(s.mbid)}">Request album</button>` : ''}
          </div>
        </div>`).join('')}</div>`;
      $r.querySelectorAll('[data-song]').forEach((btn) => {
        btn.onclick = async () => {
          const s = results.find((x) => x.mbid === btn.dataset.song);
          btn.disabled = true;
          const ok = await submitRequest(s.artist, [{ mbid: s.album.mbid, title: s.album.title, type: s.album.type, year: s.album.year }]);
          if (ok) btn.replaceWith(Object.assign(document.createElement('span'), { innerHTML: badge(ok) }));
          else btn.disabled = false;
        };
      });
    }
  } catch (e) {
    $r.innerHTML = empty(e.message);
  }
}

// MusicBrainz users' rating. Hidden with fewer than 3 votes – one or two say little.
function stars(rating) {
  if (!rating || rating.votes < 3) return '';
  const v = (Math.round(rating.value * 10) / 10).toFixed(1);
  return ` · <span class="rating" title="Rated ${v} of 5 by ${rating.votes} MusicBrainz users">★ ${v}</span>`;
}

// linkArtist: the whole card links to the artist page (the title's link is stretched over it);
// the Request button sits on top and still works
function albumCard(a, { showArtist = false, showDate = false, linkArtist = false } = {}) {
  const when = showDate && a.date ? fmtDay(a.date) : a.year;
  // With a date there is little room on small cards – "Album" is the default, so only other types are named
  const type = showDate && a.date && a.type === 'Album' ? '' : typeLabel(a.type);
  const link = linkArtist && a.artist ? `#/artist/${esc(a.artist.mbid)}` : '';
  const artistName = esc(a.artistCredit || a.artist?.name || '');
  return `
    <div class="card${link ? ' linked' : ''}" data-mbid="${esc(a.mbid)}">
      ${cover(a.mbid, a.title)}
      <div class="badge-slot">${badge(a.status, a.progress)}</div>
      <div class="body">
        <div class="title" title="${esc(a.title)}">${link ? `<a class="stretched" href="${link}">${esc(a.title)}</a>` : esc(a.title)}</div>
        <div class="sub">${[
          showArtist && a.artist ? (link ? artistName : `<a href="#/artist/${esc(a.artist.mbid)}">${artistName}</a>`) : '',
          esc(type),
          esc(when || ''),
        ].filter(Boolean).join(' · ')}</div>
      </div>
      ${!a.status && a.artist ? `<div class="actions"><button class="btn sm primary" style="width:100%" data-req="${esc(a.mbid)}">Request</button></div>` : ''}
    </div>`;
}

function bindAlbumButtons(root, list) {
  root.querySelectorAll('[data-req]').forEach((btn) => {
    btn.onclick = async () => {
      const a = list.find((x) => x.mbid === btn.dataset.req);
      btn.disabled = true;
      const status = await submitRequest(a.artist, [{ mbid: a.mbid, title: a.title, type: a.type, year: a.year }]);
      if (status) {
        btn.closest('.actions').remove();
        root.querySelector(`.card[data-mbid="${a.mbid}"] .badge-slot`).innerHTML = badge(status);
      } else btn.disabled = false;
    };
  });
}

async function submitRequest(artist, albums, monitorNew = false) {
  try {
    const { request, skipped } = await api('/requests', {
      method: 'POST',
      body: { artistMbid: artist.mbid, artistName: artist.name, albums, monitorNew },
    });
    const n = request.items.length;
    toast(`${n} ${n === 1 ? 'release' : 'releases'} requested${skipped ? ` (${skipped} already existed)` : ''}${request.status === 'pending' ? ' – pending approval' : ''}`, 'ok');
    return request.status === 'pending' ? 'pending' : 'approved';
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

// ---------- artist page ----------
async function renderArtist(mbid) {
  $app.innerHTML = shell('search', spinner);
  bindShell();
  let data;
  try {
    data = await api('/artist/' + encodeURIComponent(mbid));
  } catch (e) {
    page().innerHTML = empty(e.message);
    return;
  }
  const { artist, releaseGroups } = data;
  const selected = new Set();
  const groups = [
    ['Albums', (r) => r.primaryType === 'Album' && !r.secondaryTypes.length],
    ['EPs', (r) => r.primaryType === 'EP' && !r.secondaryTypes.length],
    ['Singles', (r) => r.primaryType === 'Single' && !r.secondaryTypes.length],
    ['Other releases', (r) => r.secondaryTypes.length > 0],
  ];
  const requestable = (r) => !r.status;
  const section = ([label, fn], i) => {
    const list = releaseGroups.filter(fn);
    if (!list.length) return '';
    const head = `<h2>${label} <span class="count">${list.length}</span></h2>`;
    const grid = `<div class="grid">${list.map((r) => `
      <div class="card ${requestable(r) ? 'selectable' : 'disabled'}" data-mbid="${esc(r.mbid)}">
        ${cover(r.mbid, r.title)}
        <div class="badge-slot">${badge(r.status, r.progress)}</div>
        ${requestable(r) ? `<div class="check">${ICON.check}</div>` : ''}
        <div class="body"><div class="title" title="${esc(r.title)}">${esc(r.title)}</div><div class="sub">${esc(typeLabel(r.type))}${r.year ? ' · ' + r.year : ''}${stars(r.rating)}</div></div>
      </div>`).join('')}</div>`;
    return i === 3 ? `<details class="more"><summary>${head}</summary>${grid}</details>` : head + grid;
  };
  const meta = [artist.type, artist.country, artist.begin && `${artist.begin}${artist.end ? '–' + artist.end : ''}`, artist.disambiguation].filter(Boolean);

  page().innerHTML = `
    <div class="hero">
      ${artist.fanart ? `<div class="backdrop" style="background-image:url('${esc(artist.fanart)}')"></div>` : ''}
      <div class="inner">
        ${artist.poster ? `<img class="poster" src="${esc(artist.poster)}" alt="" data-ph="${esc(artist.name)}">` : placeholder(artist.name, 'poster')}
        <div>
          <h1>${esc(artist.name)}</h1>
          <div class="meta">${meta.map(esc).join(' · ')}
            ${artist.inLibrary ? '<span class="badge lib">On the server</span>' : ''}
            ${artist.inLidarr ? '<span class="badge monitored">In Lidarr</span>' : ''}</div>
          ${artist.genres?.length ? `<div class="genres">${artist.genres.map((g) => `<span class="genre">${esc(g)}</span>`).join('')}</div>` : ''}
          ${artist.overview ? `<p class="overview" id="overview">${esc(artist.overview)}</p>` : ''}
        </div>
      </div>
    </div>
    <div class="actionbar">
      <button class="btn" id="selAlbums">Select all albums and EPs</button>
      <button class="btn ghost" id="selNone">Clear selection</button>
      <label class="toggle" title="Lidarr monitors the artist and grabs new albums when they come out"><input type="checkbox" id="monitorNew" ${artist.monitorNew ? 'checked disabled' : ''}> Follow new releases</label>
      <span class="grow"></span>
      <button class="btn primary" id="doRequest" disabled>Request selected (0)</button>
    </div>
    ${releaseGroups.length ? groups.map(section).join('') : empty('MusicBrainz has no albums, EPs or singles for this artist.')}`;

  const $btn = document.getElementById('doRequest');
  const update = () => {
    $btn.textContent = `Request selected (${selected.size})`;
    $btn.disabled = selected.size === 0;
    page().querySelectorAll('.card.selectable').forEach((c) => c.classList.toggle('selected', selected.has(c.dataset.mbid)));
  };
  page().querySelectorAll('.card.selectable').forEach((c) => {
    c.onclick = () => { selected.has(c.dataset.mbid) ? selected.delete(c.dataset.mbid) : selected.add(c.dataset.mbid); update(); };
  });
  document.getElementById('selAlbums').onclick = () => {
    releaseGroups.filter((r) => requestable(r) && (r.primaryType === 'Album' || r.primaryType === 'EP') && !r.secondaryTypes.length).forEach((r) => selected.add(r.mbid));
    update();
  };
  document.getElementById('selNone').onclick = () => { selected.clear(); update(); };
  document.getElementById('overview')?.addEventListener('click', (e) => e.target.classList.toggle('open'));
  $btn.onclick = async () => {
    $btn.disabled = true;
    const albums = releaseGroups.filter((r) => selected.has(r.mbid)).map((r) => ({ mbid: r.mbid, title: r.title, type: r.type, year: r.year }));
    const ok = await submitRequest(artist, albums, document.getElementById('monitorNew').checked);
    if (ok) renderArtist(mbid);
    else $btn.disabled = false;
  };
}

// ---------- requests ----------
let reqFilter = 'all';
async function renderRequests() {
  $app.innerHTML = shell('requests', `
    <h1>Requests</h1>
    <div class="muted" style="margin-bottom:18px">${me.isAdmin ? 'All requests from all users.' : 'Everything you have requested. Status updates automatically.'}</div>
    <div class="chips" id="filters"></div>
    <div id="reqlist">${spinner}</div>`);
  bindShell();
  await loadRequests();
  pollTimer = setInterval(() => { if (location.hash.startsWith('#/requests')) loadRequests(true); }, 15000);
}

async function loadRequests(silent = false) {
  const $list = document.getElementById('reqlist');
  if (!$list) return;
  let requests;
  try {
    ({ requests } = await api('/requests'));
  } catch (e) {
    if (!silent) $list.innerHTML = empty(e.message);
    return;
  }
  const FILTERS = {
    all: ['All', () => true],
    pending: ['Pending approval', (r) => r.status === 'pending'],
    active: ['In progress', (r) => ['processing', 'downloading', 'downloaded', 'partial'].includes(r.status)],
    available: ['Available', (r) => r.status === 'available'],
    failed: ['Failed / declined', (r) => r.status === 'failed' || r.status === 'declined' || !!r.error],
  };
  document.getElementById('filters').innerHTML = Object.entries(FILTERS)
    .map(([k, [label, fn]]) => `<button class="chip ${reqFilter === k ? 'active' : ''}" data-f="${k}">${label} (${requests.filter(fn).length})</button>`).join('');
  document.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { reqFilter = b.dataset.f; loadRequests(); }));

  const list = requests.filter(FILTERS[reqFilter][1]);
  if (!list.length) { $list.innerHTML = empty('No requests here.'); return; }
  $list.innerHTML = `<div class="list">${list.map((r) => {
    const canRetry = r.status !== 'pending' && r.status !== 'declined' && (r.items.some((i) => i.status === 'failed' || i.status === 'waiting') || r.error);
    const first = r.items[0];
    return `
    <div class="req">
      <div class="req-head">
        ${first ? cover(first.mbid, r.artistName, 'thumb') : placeholder(r.artistName, 'thumb')}
        <div class="info">
          <div class="title"><a href="#/artist/${esc(r.artistMbid)}">${esc(r.artistName)}</a> ${badge(r.status)}</div>
          <div class="muted small">${r.items.length} ${r.items.length === 1 ? 'release' : 'releases'} · ${esc(r.userName)} · ${fmtDate(r.createdAt)}${r.monitorNew && !(me.isAdmin && r.status === 'pending') ? ' · following new releases' : ''}</div>
          ${me.isAdmin && r.status === 'pending' ? `<label class="toggle small" title="Lidarr monitors the artist and grabs new albums when they come out"><input type="checkbox" data-follow="${r.id}" ${r.monitorNew ? 'checked' : ''}> Follow new releases</label>` : ''}
        </div>
        <div class="btns">
          ${me.isAdmin && r.status === 'pending' ? `<button class="btn sm green" data-act="approve" data-id="${r.id}">Approve</button><button class="btn sm red" data-act="decline" data-id="${r.id}">Decline</button>` : ''}
          ${canRetry ? `<button class="btn sm" data-act="retry" data-id="${r.id}">Retry</button>` : ''}
          ${me.isAdmin || r.status === 'pending' ? `<button class="btn sm ghost" data-act="delete" data-id="${r.id}">Delete</button>` : ''}
        </div>
      </div>
      ${r.error ? `<div class="req-error">⚠ ${esc(r.error)}</div>` : ''}
      <div class="req-items">${r.items.map((i) => `
        <div class="req-item">
          <span class="t">${esc(i.title)} <span class="y">${esc(typeLabel(i.type))}${i.year ? ' · ' + i.year : ''}</span>${i.error ? `<div class="err">${esc(i.error)}</div>` : ''}</span>
          ${i.status === 'downloading' && i.progress != null ? `<div class="progress"><div style="width:${Number(i.progress)}%"></div></div>` : ''}
          ${badge(i.status, i.progress)}
        </div>`).join('')}</div>
    </div>`;
  }).join('')}</div>`;

  // Admins can change this before approving
  $list.querySelectorAll('[data-follow]').forEach((c) => {
    c.onchange = async () => {
      c.disabled = true;
      try {
        await api(`/requests/${c.dataset.follow}`, { method: 'PATCH', body: { monitorNew: c.checked } });
      } catch (e) {
        c.checked = !c.checked;
        toast(e.message, 'err');
      }
      c.disabled = false;
    };
  });
  $list.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const { act, id } = b.dataset;
      if (act === 'delete' && !confirm('Delete this request? (This does not remove anything from Lidarr or Emby.)')) return;
      b.disabled = true;
      try {
        if (act === 'delete') await api(`/requests/${id}`, { method: 'DELETE' });
        else await api(`/requests/${id}/${act}`, { method: 'POST' });
        toast({ approve: 'Approved – sending to Lidarr', decline: 'Declined', retry: 'Retrying', delete: 'Deleted' }[act], 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
      loadRequests();
    };
  });
}

// ---------- settings (admin) ----------
function settingsFormHtml(s) {
  const keyField = (name, label, saved, hint) => `
    <div class="field"><label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="password" autocomplete="new-password" spellcheck="false"
        placeholder="${saved ? `Unchanged (${esc(saved)})` : 'Paste API key'}" ${name === 'embyApiKey' && !saved ? 'required' : ''}>
      <div class="hint">${hint}</div></div>`;
  return `
  <form id="setform" class="settings" autocomplete="off">
    <div class="panel">
      <h3><span class="dot" id="dot-emby"></span> Emby</h3>
      <p class="muted small panel-intro">Used for sign-in and to see what is already on the server.</p>
      <div class="form-grid">
        <div class="field"><label for="embyUrl">Address</label>
          <input id="embyUrl" name="embyUrl" value="${esc(s.embyUrl)}" placeholder="http://192.168.1.50:8096" required spellcheck="false">
          <div class="hint">The Emby server, including the port. Use its IP address on the local network.</div></div>
        ${keyField('embyApiKey', 'API key', s.embyApiKey, 'Emby Dashboard → Advanced → API Keys → “New API Key”.')}
      </div>
      <div class="test-row"><button type="button" class="btn sm" data-test="emby">Test connection</button><span id="res-emby" class="small"></span></div>
    </div>

    <div class="panel">
      <h3><span class="dot" id="dot-lidarr"></span> Lidarr</h3>
      <p class="muted small panel-intro">Lidarr finds and downloads the requested albums.</p>
      <div class="form-grid">
        <div class="field"><label for="lidarrUrl">Address</label>
          <input id="lidarrUrl" name="lidarrUrl" value="${esc(s.lidarrUrl)}" placeholder="http://192.168.1.10:8686" spellcheck="false">
          <div class="hint">The Lidarr server, including the port.</div></div>
        ${keyField('lidarrApiKey', 'API key', s.lidarrApiKey, 'Lidarr → Settings → General → API Key.')}
      </div>
      <div class="test-row"><button type="button" class="btn sm" data-test="lidarr">Test connection</button><span id="res-lidarr" class="small"></span></div>
      <div class="form-grid three" id="lidarr-opts">
        <div class="field"><label for="lidarrRootFolder">Root folder</label><select id="lidarrRootFolder" name="lidarrRootFolder"></select></div>
        <div class="field"><label for="lidarrQualityProfileId">Quality profile</label><select id="lidarrQualityProfileId" name="lidarrQualityProfileId"></select></div>
        <div class="field"><label for="lidarrMetadataProfileId">Metadata profile</label><select id="lidarrMetadataProfileId" name="lidarrMetadataProfileId"></select>
          <div class="hint">Must include EP and Single for users to be able to request those.</div></div>
      </div>
    </div>

    <div class="panel">
      <h3>Requests</h3>
      <label class="toggle" style="color:var(--text)"><input type="checkbox" name="autoApprove" ${s.autoApprove ? 'checked' : ''}> Approve requests automatically</label>
      <div class="hint" style="margin:6px 0 16px 25px">Off = an Emby administrator must approve requests from regular users.</div>
      <div class="form-grid">
        <div class="field"><label for="appName">Site name</label><input id="appName" name="appName" value="${esc(s.appName)}" placeholder="Tonearr"></div>
        <div class="field"><label for="mbUserAgent">MusicBrainz User-Agent</label><input id="mbUserAgent" name="mbUserAgent" value="${esc(s.mbUserAgent)}" spellcheck="false">
          <div class="hint">MusicBrainz asks for contact info, e.g. “Tonearr/0.1 ( you@example.com )”.</div></div>
      </div>
    </div>

    <div class="panel">
      <h3>Discover</h3>
      <label class="toggle" style="color:var(--text)"><input type="checkbox" name="listenbrainzEnabled" ${s.listenbrainzEnabled ? 'checked' : ''}> Show suggestions from ListenBrainz</label>
      <div class="hint" style="margin:6px 0 0 25px">New and upcoming releases by artists on the server, in Lidarr or requested here, what is popular right now, and artists similar to the ones each user plays. The public lists are fetched every 6 and 24 hours and filtered here. For similar artists, the IDs of the artists users play most are looked up – never user names or play counts.</div>
    </div>

    <div class="panel">
      <h3><span class="dot" id="dot-email"></span> Email notifications</h3>
      <p class="muted small panel-intro">Emails administrators when a request needs approval, and lets users get email about their own requests. Each user picks what they want under <i>Notifications</i>.</p>
      <label class="toggle" style="color:var(--text)"><input type="checkbox" name="emailEnabled" ${s.emailEnabled ? 'checked' : ''}> Send email notifications</label>
      <div id="email-opts" class="${s.emailEnabled ? '' : 'disabled-block'}" style="margin-top:16px">
        <div class="form-grid cols3">
          <div class="field"><label for="smtpHost">Mail server (SMTP)</label>
            <input id="smtpHost" name="smtpHost" value="${esc(s.smtpHost)}" placeholder="smtp.gmail.com" spellcheck="false"></div>
          <div class="field"><label for="smtpSecurity">Encryption</label>
            <select id="smtpSecurity" name="smtpSecurity">
              ${[['starttls', 'STARTTLS'], ['tls', 'SSL/TLS'], ['none', 'None']].map(([v, l]) => `<option value="${v}" ${s.smtpSecurity === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="field"><label for="smtpPort">Port</label>
            <input id="smtpPort" name="smtpPort" type="number" min="1" max="65535" value="${esc(s.smtpPort || 587)}"></div>
        </div>
        <div class="form-grid">
          <div class="field"><label for="smtpUser">Username</label>
            <input id="smtpUser" name="smtpUser" value="${esc(s.smtpUser)}" autocomplete="off" spellcheck="false">
            <div class="hint">Usually your full email address. Leave empty if the server doesn't need sign-in.</div></div>
          <div class="field"><label for="smtpPassword">Password</label>
            <input id="smtpPassword" name="smtpPassword" type="password" autocomplete="new-password" placeholder="${s.smtpPassword ? 'Unchanged' : ''}">
            <div class="hint">For Gmail and Outlook, create an <i>app password</i> – your normal password won't work.</div></div>
          <div class="field"><label for="emailFrom">Sender</label>
            <input id="emailFrom" name="emailFrom" value="${esc(s.emailFrom)}" placeholder="Tonearr &lt;you@example.com&gt;" spellcheck="false">
            <div class="hint">Many mail servers only accept the address you sign in with.</div></div>
          <div class="field"><label for="appUrl">Tonearr address</label>
            <input id="appUrl" name="appUrl" value="${esc(s.appUrl || location.origin)}" spellcheck="false">
            <div class="hint">Used for links in the emails.</div></div>
        </div>
        <div class="field"><label for="adminEmails">Notify about new requests</label>
          <input id="adminEmails" name="adminEmails" value="${esc(s.adminEmails)}" placeholder="admin@example.com, other@example.com" spellcheck="false">
          <div class="hint">One or more addresses, separated by commas, that get an email when a request needs approval (only happens when requests aren't approved automatically). Test emails go to the first one.</div></div>
        <div class="test-row"><button type="button" class="btn sm" id="testEmail">Send test email</button><span id="res-email" class="small"></span></div>
      </div>
    </div>

    <div class="savebar">
      <span class="muted small" id="save-msg">The Emby connection is tested before saving.</span>
      <button type="submit" class="btn primary">Save settings</button>
    </div>
  </form>`;
}

function bindSettingsForm(s, { onSaved } = {}) {
  const form = document.getElementById('setform');
  const val = (n) => form.elements[n].value.trim();
  const setDot = (which, ok) => { const d = document.getElementById('dot-' + which); d.className = 'dot ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); };
  const setRes = (which, html, ok) => { const r = document.getElementById('res-' + which); r.innerHTML = html; r.className = 'small ' + (ok ? 'ok-text' : 'err-text'); };

  const fillSelect = (name, options, current, fmt) => {
    const sel = form.elements[name];
    sel.innerHTML = `<option value="">First available</option>` + options.map((o) => {
      const v = typeof o === 'object' ? o.id : o;
      return `<option value="${esc(v)}" ${String(v) === String(current ?? '') ? 'selected' : ''}>${esc(fmt(o))}</option>`;
    }).join('');
  };
  const lidarrOpts = (data) => {
    const cur = { root: form.elements.lidarrRootFolder.value || s.lidarrRootFolder, q: form.elements.lidarrQualityProfileId.value || s.lidarrQualityProfileId, m: form.elements.lidarrMetadataProfileId.value || s.lidarrMetadataProfileId };
    fillSelect('lidarrRootFolder', data?.roots || [], cur.root, (r) => r);
    fillSelect('lidarrQualityProfileId', data?.qualityProfiles || [], cur.q, (p) => p.name);
    fillSelect('lidarrMetadataProfileId', data?.metadataProfiles || [], cur.m, (p) => p.name);
    document.getElementById('lidarr-opts').classList.toggle('disabled-block', !data);
  };
  lidarrOpts(null);

  const test = async (which, quiet = false) => {
    const url = val(which + 'Url');
    const apiKey = val(which + 'ApiKey') || s[which + 'ApiKey'];
    if (!url || !apiKey) { if (!quiet) setRes(which, 'Enter an address and API key', false); setDot(which, null); return; }
    setRes(which, 'Testing…', true);
    try {
      const r = await api(`/settings/test/${which}`, { method: 'POST', body: { url, apiKey } });
      setDot(which, true);
      if (which === 'emby') setRes(which, `✓ Connected to ${esc(r.name)} (v${esc(r.version)})${r.albums != null ? ` – ${r.albums} albums in the library` : ''}`, true);
      else { setRes(which, `✓ Connected to Lidarr v${esc(r.version)}`, true); lidarrOpts(r); }
      return true;
    } catch (e) {
      setDot(which, false);
      setRes(which, '✗ ' + esc(e.message), false);
      if (which === 'lidarr') lidarrOpts(null);
      return false;
    }
  };
  form.querySelectorAll('[data-test]').forEach((b) => (b.onclick = async () => { b.disabled = true; await test(b.dataset.test); b.disabled = false; }));

  // Email
  const emailValues = () => ({
    emailEnabled: form.elements.emailEnabled.checked,
    smtpHost: val('smtpHost'), smtpPort: val('smtpPort'), smtpSecurity: form.elements.smtpSecurity.value,
    smtpUser: val('smtpUser'), smtpPassword: val('smtpPassword'),
    emailFrom: val('emailFrom'), adminEmails: val('adminEmails'), appUrl: val('appUrl'),
  });
  form.elements.emailEnabled.onchange = (e) => document.getElementById('email-opts').classList.toggle('disabled-block', !e.target.checked);
  // Switch to the usual port for the chosen encryption, unless a custom port has been entered
  const PORTS = { starttls: '587', tls: '465', none: '25' };
  form.elements.smtpSecurity.onchange = (e) => {
    if (Object.values(PORTS).includes(form.elements.smtpPort.value)) form.elements.smtpPort.value = PORTS[e.target.value];
  };
  document.getElementById('testEmail').onclick = async (e) => {
    e.target.disabled = true;
    setRes('email', 'Sending…', true);
    try {
      const v = emailValues();
      const r = await api('/settings/test/email', { method: 'POST', body: { ...v, to: v.adminEmails } });
      setDot('email', true);
      setRes('email', `✓ Sent to ${esc(r.to)} – check the inbox (and the spam folder)`, true);
    } catch (err) {
      setDot('email', false);
      setRes('email', '✗ ' + esc(err.message), false);
    }
    e.target.disabled = false;
  };

  // Test saved connections as soon as the page opens
  if (s.embyUrl && s.embyApiKey) test('emby', true);
  if (s.lidarrUrl && s.lidarrApiKey) test('lidarr', true);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const body = {
      embyUrl: val('embyUrl'), embyApiKey: val('embyApiKey'),
      lidarrUrl: val('lidarrUrl'), lidarrApiKey: val('lidarrApiKey'),
      lidarrRootFolder: form.elements.lidarrRootFolder.value,
      lidarrQualityProfileId: form.elements.lidarrQualityProfileId.value,
      lidarrMetadataProfileId: form.elements.lidarrMetadataProfileId.value,
      autoApprove: form.elements.autoApprove.checked,
      listenbrainzEnabled: form.elements.listenbrainzEnabled.checked,
      appName: val('appName'), mbUserAgent: val('mbUserAgent'),
      ...emailValues(),
    };
    try {
      const r = await api('/settings', { method: 'PUT', body });
      toast(r.changed.length ? 'Settings saved' : 'No changes', 'ok');
      onSaved?.(r.settings);
    } catch (err) {
      toast(err.message, 'err');
      document.getElementById('save-msg').innerHTML = `<span class="err-text">${esc(err.message)}</span>`;
    }
    btn.disabled = false;
  };
}

async function renderSettings() {
  $app.innerHTML = shell('settings', `<h1>Settings</h1><div class="muted" style="margin-bottom:20px">Connections to Emby, Lidarr and the mail server. Changes take effect immediately.</div><div id="st">${spinner}</div>`);
  bindShell();
  // Library panel – refreshes itself every few seconds while the release group lookup is running
  let libTimer = null;
  const renderLib = (lib) => {
    const $lib = document.getElementById('lib');
    if (!$lib) return;
    clearTimeout(libTimer);
    const l = lib?.releaseLookup;
    let lookup = '';
    if (l?.running) {
      lookup = `<span class="spin-inline"></span>Looking up release groups in MusicBrainz: ${l.done} / ${l.total}`;
    } else if (l?.releaseOnly) {
      const pending = l.releaseOnly - l.matched - l.notFound;
      lookup = `${l.matched} of ${l.releaseOnly} matched via release ID`
        + (l.notFound ? ` · ${l.notFound} not found in MusicBrainz` : '')
        + (pending ? ` · ${pending} not looked up yet` : '');
    }
    $lib.innerHTML = lib
      ? `<div><span>Emby music library</span></div><div>${lib.albums} albums, ${lib.artists} artists with a MusicBrainz ID<br><span class="muted small">Indexed ${fmtDate(lib.builtAt)}</span></div>`
        + (lookup ? `<div><span>Tagged with only a release ID</span></div><div>${lookup}${l.error ? `<br><span class="err-text small">${esc(l.error)}</span>` : ''}</div>` : '')
      : '<div><span>Emby music library</span></div><div>Not indexed yet</div>';
    if (l?.running) libTimer = setTimeout(pollLib, 3000);
  };
  const pollLib = () => api('/admin/library').then((r) => renderLib(r.library)).catch(() => {});

  const load = async () => {
    const [{ settings: s }, status] = await Promise.all([api('/settings'), api('/admin/status').catch(() => null)]);
    document.getElementById('st').innerHTML = settingsFormHtml(s) + `
      <div class="settings" style="margin-top:16px">
        <div class="panel">
          <h3>Library and status</h3>
          <div class="kv" id="lib"></div>
          <div class="test-row"><button class="btn sm" id="sync">Sync now</button><span class="muted small">Re-reads the Emby library and updates the status of requests.</span></div>
        </div>
      </div>`;
    renderLib(status?.library);
    // Refresh the user too, so the "setup isn't finished" notice goes away once everything is filled in
    bindSettingsForm(s, { onSaved: async () => { me = (await api('/me')).user; renderSettings(); } });
    document.getElementById('sync').onclick = async (e) => {
      e.target.disabled = true;
      try { await api('/admin/sync', { method: 'POST' }); toast('Synced', 'ok'); } catch (err) { toast(err.message, 'err'); }
      load();
    };
  };
  load().catch((e) => (document.getElementById('st').innerHTML = empty(e.message)));
}

// ---------- notifications (every user) ----------
async function renderNotifications() {
  $app.innerHTML = shell('notifications', `<h1>Notifications</h1><div class="muted" style="margin-bottom:20px">Get an email when something happens with your requests.</div><div id="nt">${spinner}</div>`);
  bindShell();
  const $nt = document.getElementById('nt');
  let data;
  try {
    data = await api('/me/notifications');
  } catch (e) {
    $nt.innerHTML = empty(e.message);
    return;
  }
  const { prefs, events, enabled } = data;
  if (!enabled) {
    $nt.innerHTML = empty('Email notifications are turned off.' + (me.isAdmin ? ' Turn them on under Settings → Email notifications.' : ''));
    return;
  }
  $nt.innerHTML = `
    <form class="settings" id="notform" autocomplete="off">
      <div class="panel">
        <label class="toggle" style="color:var(--text)"><input type="checkbox" name="notify" ${prefs.notify ? 'checked' : ''}> Email me about my requests</label>
        <div id="notify-opts" class="${prefs.notify ? '' : 'disabled-block'}" style="margin-top:16px">
          <div class="field" style="max-width:420px"><label for="email">Email address</label>
            <input id="email" name="email" type="email" value="${esc(prefs.email)}" placeholder="you@example.com" autocomplete="email"></div>
          <div class="field"><label>Email me when a request is…</label>
            <div class="checks">${Object.entries(events).map(([k, label]) => `
              <label class="toggle"><input type="checkbox" name="ev" value="${esc(k)}" ${prefs.events.includes(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
            </div>
            <div class="hint">You get each kind of email at most once per request.${me.isAdmin ? ' Emails about new requests that need approval are set up under Settings.' : ''}</div></div>
        </div>
      </div>
      <div class="savebar">
        <button type="button" class="btn ghost" id="sendTest" ${prefs.email ? '' : 'disabled'}>Send me a test email</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`;
  const form = document.getElementById('notform');
  form.elements.notify.onchange = (e) => document.getElementById('notify-opts').classList.toggle('disabled-block', !e.target.checked);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const body = {
        notify: form.elements.notify.checked,
        email: form.elements.email.value.trim(),
        events: [...form.querySelectorAll('[name=ev]:checked')].map((c) => c.value),
      };
      const r = await api('/me/notifications', { method: 'PUT', body });
      document.getElementById('sendTest').disabled = !r.prefs.email;
      toast('Saved', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    btn.disabled = false;
  };
  document.getElementById('sendTest').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/me/notifications/test', { method: 'POST' });
      toast(`Test email sent to ${r.to}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    e.target.disabled = false;
  };
}

// ---------- router ----------
let publicStatus = null;
async function router() {
  clearInterval(pollTimer);
  if (!publicStatus) publicStatus = await api('/public/status').catch(() => ({ setupRequired: false }));
  if (publicStatus.setupRequired) { me = null; return renderLogin(); }
  const hash = location.hash || '#/';
  if (!me && hash !== '#/login') {
    try { me = (await api('/me')).user; } catch { return; }
  }
  if (hash === '#/login') return me ? (location.hash = '#/') : renderLogin();
  const [path] = hash.slice(1).split('?');
  window.scrollTo(0, 0);
  if (path === '/' || path === '') return renderHome();
  if (path === '/search') return renderSearch();
  if (path === '/requests') return renderRequests();
  if (path === '/settings' && me.isAdmin) return renderSettings();
  if (path === '/notifications') return renderNotifications();
  const m = path.match(/^\/artist\/([0-9a-f-]{36})$/i);
  if (m) return renderArtist(m[1]);
  location.hash = '#/';
}

window.addEventListener('hashchange', router);
router();
