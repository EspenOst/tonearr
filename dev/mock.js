// Fake Emby and Lidarr servers for local testing.
//   node dev/mock.js   -> Emby on :18096, Lidarr on :18686, SMTP on :12525
// Users: admin/admin (administrator), alice/alice (regular user)
// Simulates: artist added -> album list fetched (from real MusicBrainz) -> search -> download -> shows up in Emby.
import http from 'node:http';

const UA = 'Tonearr-dev-mock/0.1 ( local testing )';
const users = { admin: { pw: 'admin', admin: true, id: 'u-admin' }, alice: { pw: 'alice', admin: false, id: 'u-alice' } };

// Emby library (starts with one album so "Available" can be tested)
const embyAlbums = [
  { Id: 'e1', Name: 'OK Computer', AlbumArtist: 'Radiohead', ProviderIds: { MusicBrainzReleaseGroup: 'b1392450-e666-3926-a536-22c65f834433' } },
  // Tagged with only a release ID – Tonearr looks up the release group in the background
  { Id: 'e2', Name: '72 Seasons', AlbumArtist: 'Metallica', ProviderIds: { MusicBrainzAlbum: '180078e3-41b8-49f4-a534-5867cce7435d' } },
  // A release ID MusicBrainz doesn't know – shows up as "not found"
  { Id: 'e3', Name: 'Unknown Album', AlbumArtist: 'Nobody', ProviderIds: { MusicBrainzAlbum: '00000000-0000-4000-8000-000000000000' } },
];
const embyArtists = [
  { Id: 'a1', Name: 'Radiohead', ProviderIds: { MusicBrainzArtist: 'a74b1b7f-71a5-4011-9441-d0b5e4122711' } },
  { Id: 'a2', Name: 'Metallica', ProviderIds: { MusicBrainzArtist: '65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab' } },
];

// What each user has played and marked as favourite (admin has played nothing)
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const track = (artist, name, plays, lastPlayed) => ({
  Id: 't-' + name, Name: name, Type: 'Audio', AlbumArtist: artist.Name, ProviderIds: {},
  AlbumArtists: [{ Name: artist.Name, Id: artist.Id }], ArtistItems: [{ Name: artist.Name, Id: artist.Id }],
  UserData: { PlayCount: plays, LastPlayedDate: lastPlayed, Played: true },
});
const listening = {
  'u-alice': {
    played: [
      track(embyArtists[0], 'Paranoid Android', 42, daysAgo(2)),
      track(embyArtists[0], 'Karma Police', 30, daysAgo(10)),
      track(embyArtists[1], 'Battery', 8, daysAgo(400)),
    ],
    favourites: [{ ...embyArtists[1], Type: 'MusicArtist' }],
  },
};

// Lidarr state
const artists = [];
const albums = [];
let nextId = 1;

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
const body = async (req) => { const c = []; for await (const x of req) c.push(x); const s = Buffer.concat(c).toString(); return s ? JSON.parse(s) : {}; };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'POST' && p === '/Users/AuthenticateByName') {
    const b = await body(req);
    const usr = users[b.Username?.toLowerCase()];
    if (!usr || usr.pw !== b.Pw) return json(res, 401, {});
    return json(res, 200, { AccessToken: 'tok-' + usr.id, User: { Id: usr.id, Name: b.Username, Policy: { IsAdministrator: usr.admin } } });
  }
  if (p === '/Sessions/Logout') return json(res, 204);
  if (req.headers['x-emby-token'] !== 'emby-key') return json(res, 401, {});
  if (p === '/System/Info') return json(res, 200, { ServerName: 'Mock Emby', Version: '4.9.0' });
  const userItems = p.match(/^\/Users\/([^/]+)\/Items$/);
  if (userItems) {
    const l = listening[decodeURIComponent(userItems[1])] || { played: [], favourites: [] };
    const filters = u.searchParams.get('Filters') || '';
    const items = filters.includes('IsFavorite') ? l.favourites : filters.includes('IsPlayed') ? l.played : [];
    return json(res, 200, { Items: items, TotalRecordCount: items.length });
  }
  if (p === '/Items') {
    const t = u.searchParams.get('IncludeItemTypes');
    { const items = t === 'MusicAlbum' ? embyAlbums : embyArtists; return json(res, 200, { Items: items, TotalRecordCount: items.length }); }
  }
  json(res, 404, {});
}).listen(18096, () => console.log('Mock Emby  : http://localhost:18096  (API key: emby-key)'));

async function fetchMbAlbums(mbid) {
  const r = await fetch(`https://musicbrainz.org/ws/2/release-group?artist=${mbid}&type=album|ep&limit=100&fmt=json`, { headers: { 'User-Agent': UA } });
  const d = await r.json();
  // Simulates a metadata profile that only includes studio albums and EPs
  return (d['release-groups'] || []).filter((g) => !(g['secondary-types'] || []).length);
}

function stats(a) {
  return { trackFileCount: a.files, trackCount: 10, totalTrackCount: 10, percentOfTracks: a.files * 10 };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace('/api/v1', '');
  if (req.headers['x-api-key'] !== 'lidarr-key') return json(res, 401, {});
  const m = req.method;
  try {
    if (p === '/system/status') return json(res, 200, { version: '2.9.0-mock' });
    if (p === '/rootfolder') return json(res, 200, [{ id: 1, path: '/music' }]);
    if (p === '/qualityprofile') return json(res, 200, [{ id: 1, name: 'Lossless' }, { id: 2, name: 'Standard' }]);
    if (p === '/metadataprofile') return json(res, 200, [{ id: 1, name: 'Standard' }]);
    if (p === '/artist/lookup') {
      const mbid = u.searchParams.get('term').replace('lidarr:', '');
      const r = await fetch(`https://musicbrainz.org/ws/2/artist/${mbid}?fmt=json`, { headers: { 'User-Agent': UA } });
      const a = await r.json();
      // Real pictures from Lidarr's metadata server, like Lidarr itself
      const meta = await fetch(`https://api.lidarr.audio/api/v0.4/artist/${mbid}`).then((x) => x.json()).catch(() => ({}));
      const images = (meta.images || []).map((i) => ({ coverType: i.CoverType.toLowerCase(), remoteUrl: i.remoteUrl }));
      return json(res, 200, [{ foreignArtistId: mbid, artistName: a.name || meta.artistname, overview: `${a.name || meta.artistname} is an artist (mock description from Lidarr).`, images }]);
    }
    if (p === '/artist' && m === 'GET') return json(res, 200, artists.filter((a) => !u.searchParams.get('mbId') || a.foreignArtistId === u.searchParams.get('mbId')));
    if (p === '/artist' && m === 'POST') {
      const b = await body(req);
      if (artists.some((a) => a.foreignArtistId === b.foreignArtistId)) return json(res, 400, [{ errorMessage: 'This artist has already been added' }]);
      const a = { ...b, id: nextId++ };
      artists.push(a);
      console.log(`[lidarr] added artist ${a.artistName}`);
      // The album list arrives after a while (like a real "RefreshArtist")
      setTimeout(async () => {
        for (const g of await fetchMbAlbums(a.foreignArtistId)) {
          albums.push({ id: nextId++, artistId: a.id, foreignAlbumId: g.id, title: g.title, monitored: false, files: 0, releases: [] });
        }
        console.log(`[lidarr] fetched ${albums.filter((x) => x.artistId === a.id).length} albums for ${a.artistName}`);
      }, 4000);
      return json(res, 201, a);
    }
    let mm;
    if ((mm = p.match(/^\/artist\/(\d+)$/))) {
      const a = artists.find((x) => x.id === Number(mm[1]));
      if (!a) return json(res, 404, {});
      if (m === 'PUT') Object.assign(a, await body(req));
      return json(res, 200, a);
    }
    if (p === '/album' && m === 'GET') {
      const id = Number(u.searchParams.get('artistId'));
      return json(res, 200, albums.filter((a) => a.artistId === id).map((a) => ({ ...a, statistics: stats(a) })));
    }
    if (p === '/album/monitor' && m === 'PUT') {
      const b = await body(req);
      albums.filter((a) => b.albumIds.includes(a.id)).forEach((a) => (a.monitored = b.monitored));
      return json(res, 202, {});
    }
    if (p === '/command' && m === 'POST') {
      const b = await body(req);
      console.log(`[lidarr] command ${b.name}`, b.albumIds || b.artistId || '');
      if (b.name === 'AlbumSearch') {
        for (const id of b.albumIds) {
          const a = albums.find((x) => x.id === id);
          // "Finds" a release after 5 sec, downloads for 20 sec, imports, and Emby sees it 10 sec later
          setTimeout(() => { a.dlStart = Date.now(); }, 5000);
          setTimeout(() => {
            a.dlStart = null;
            a.files = 10;
            const artist = artists.find((x) => x.id === a.artistId);
            setTimeout(() => {
              embyAlbums.push({ Id: 'e' + a.id, Name: a.title, AlbumArtist: artist.artistName, ProviderIds: { MusicBrainzReleaseGroup: a.foreignAlbumId } });
              console.log(`[emby] ${a.title} added to the library`);
            }, 10000);
          }, 25000);
        }
      }
      return json(res, 201, { id: nextId++, name: b.name });
    }
    if (p === '/queue') {
      const records = albums.filter((a) => a.dlStart).map((a) => {
        const done = Math.min(1, (Date.now() - a.dlStart) / 20000);
        return { albumId: a.id, artistId: a.artistId, title: a.title, size: 100e6, sizeleft: 100e6 * (1 - done), status: 'downloading' };
      });
      return json(res, 200, { records, totalRecords: records.length });
    }
    json(res, 404, { message: 'mock: unknown ' + p });
  } catch (e) {
    json(res, 500, { message: e.message });
  }
}).listen(18686, () => console.log('Mock Lidarr: http://localhost:18686  (API key: lidarr-key)'));

// ---------- Fake mail server (SMTP, no encryption) ----------
// Settings → Email notifications: server localhost, port 12525, encryption "None", any username/password.
// Received emails are printed here.
import net from 'node:net';
net.createServer((sock) => {
  let data = null;
  let authStep = 0;
  const say = (l) => sock.write(l + '\r\n');
  say('220 mock-smtp ready');
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (data !== null) {
        if (line !== '.') { data.push(line); continue; }
        const raw = data.join('\n');
        data = null;
        const [head, body = ''] = raw.split('\n\n');
        const h = (k) => head.match(new RegExp(`^${k}: (.*)$`, 'mi'))?.[1] || '';
        const subject = h('Subject').replace(/=\?UTF-8\?B\?(.*?)\?=/g, (_, b) => Buffer.from(b, 'base64').toString());
        console.log(`\n✉  Mock mail to ${h('To')} – ${subject}\n${Buffer.from(body.replace(/\s/g, ''), 'base64').toString().replace(/^/gm, '   ')}`);
        say('250 queued');
        continue;
      }
      if (authStep === 1) { authStep = 2; say('334 UGFzc3dvcmQ6'); continue; }
      if (authStep === 2) { authStep = 0; say('235 ok'); continue; }
      const cmd = line.split(' ')[0].toUpperCase();
      if (cmd === 'EHLO') { say('250-mock-smtp'); say('250 AUTH PLAIN LOGIN'); }
      else if (cmd === 'AUTH') { if (/LOGIN/i.test(line)) { authStep = 1; say('334 VXNlcm5hbWU6'); } else say('235 ok'); }
      else if (cmd === 'DATA') { data = []; say('354 go ahead'); }
      else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
      else if (cmd === 'RCPT' && /bounce@/i.test(line)) say('550 no such user');
      else say('250 ok');
    }
  });
  sock.on('error', () => {});
}).listen(12525, () => console.log('Mock SMTP:   localhost:12525  (no encryption)'));
