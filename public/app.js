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
  monitored: 'In Lidarr',
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
async function renderHome() {
  $app.innerHTML = shell('home', `
    <div class="welcome">
      <h1>Hi, ${esc(me.name)} 👋</h1>
      <div class="muted">Find artists and albums, and request them for the server.</div>
      <form class="searchbox big-search" id="bigsearch">${ICON.search}<input name="q" placeholder="What do you want to listen to?" autocomplete="off"></form>
    </div>
    <h2>${me.isAdmin ? 'Recent requests' : 'My recent requests'}</h2>
    <div id="recent">${spinner}</div>`);
  bindShell();
  document.getElementById('bigsearch').onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) location.hash = `#/search?q=${encodeURIComponent(q)}&type=artist`;
  };
  try {
    const { requests } = await api('/requests');
    const items = requests.flatMap((r) => r.items.map((i) => ({ ...i, artistName: r.artistName, artistMbid: r.artistMbid }))).slice(0, 24);
    document.getElementById('recent').innerHTML = items.length
      ? `<div class="grid">${items.map((i) => `
          <a class="card" href="#/artist/${esc(i.artistMbid)}">
            ${cover(i.mbid, i.title)}
            <div class="badge-slot">${badge(i.status, i.progress)}</div>
            <div class="body"><div class="title">${esc(i.title)}</div><div class="sub">${esc(i.artistName)}${i.year ? ' · ' + i.year : ''}</div></div>
          </a>`).join('')}</div>`
      : empty('No requests yet. Search for an artist to get started!');
  } catch (e) {
    document.getElementById('recent').innerHTML = empty(e.message);
  }
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

function albumCard(a, { showArtist = false } = {}) {
  return `
    <div class="card" data-mbid="${esc(a.mbid)}">
      ${cover(a.mbid, a.title)}
      <div class="badge-slot">${badge(a.status, a.progress)}</div>
      <div class="body">
        <div class="title" title="${esc(a.title)}">${esc(a.title)}</div>
        <div class="sub">${showArtist && a.artist ? `<a href="#/artist/${esc(a.artist.mbid)}">${esc(a.artistCredit)}</a> · ` : ''}${esc(typeLabel(a.type))}${a.year ? ' · ' + a.year : ''}</div>
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
        <div class="body"><div class="title" title="${esc(r.title)}">${esc(r.title)}</div><div class="sub">${esc(typeLabel(r.type))}${r.year ? ' · ' + r.year : ''}</div></div>
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
      <label class="toggle"><input type="checkbox" id="monitorNew" ${artist.monitorNew ? 'checked disabled' : ''}> Follow new releases</label>
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
          <div class="muted small">${r.items.length} ${r.items.length === 1 ? 'release' : 'releases'} · ${esc(r.userName)} · ${fmtDate(r.createdAt)}${r.monitorNew ? ' · following new releases' : ''}</div>
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
      appName: val('appName'), mbUserAgent: val('mbUserAgent'),
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
  $app.innerHTML = shell('settings', `<h1>Settings</h1><div class="muted" style="margin-bottom:20px">Connections to Emby and Lidarr. Changes take effect immediately.</div><div id="st">${spinner}</div>`);
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
  const m = path.match(/^\/artist\/([0-9a-f-]{36})$/i);
  if (m) return renderArtist(m[1]);
  location.hash = '#/';
}

window.addEventListener('hashchange', router);
router();
