# Tonearr

A simple, Seerr-like request site for music.

- **Sign in with your Emby account.** Emby administrators are administrators here too.
- **Discover** suggests what to request: new and upcoming albums by artists you already have, their best-known albums you're missing, what's popular right now, and what other users have requested. Anything already on the server is left out.
- **Search MusicBrainz** for artists, albums and songs.
- **Artist page** with albums, EPs, singles and other releases, newest first, with the rating from MusicBrainz users (shown from 3 votes). Pick what you want, click "Request", and optionally tick "Follow new releases".
- **Lidarr** adds the artist without monitoring anything, then monitors and searches only for the albums you picked.
- **Status** comes from Lidarr (searching, downloading with %, downloaded) and from the Emby library (available). Anything already in Emby is marked "Available" in search and can't be requested again.
- **No "Various Artists" or "[unknown]".** Compilations credited to Various Artists, and releases by MusicBrainz' placeholder for an unknown artist, are hidden from search and can't be requested, since Lidarr would add them as one huge artist.
- **Approval** is optional (`AUTO_APPROVE`). Administrators can approve, decline, retry and delete requests.
- **Email notifications** (optional, off by default): administrators get an email when a request needs approval, and users can choose which status changes on their own requests they want an email about.
- The app has no dependencies, just Node.js. Data is stored in a single JSON file (`/data/db.json`).

## Architecture

```
 Browser ──► Tonearr (:5056)
               ├─► Emby                sign-in + library index (every 5 min)
               ├─► MusicBrainz         search / artist / album list (max 1 req/sec, cached)
               ├─► ListenBrainz        new/upcoming releases, popular albums and similar artists for Discover
               └─► Lidarr              add artist → monitor albums → AlbumSearch → queue/status
```

Tonearr, Emby and Lidarr can run on the same machine or on different machines. Tonearr only needs to reach Emby and Lidarr over HTTP.

## Installing with Docker

Works on any host with Docker: a Linux server, a NAS, a Raspberry Pi, or Docker Desktop on Windows/macOS. Images are published for `amd64` and `arm64`.

1. **Create a folder** for Tonearr and save [`docker-compose.yml`](docker-compose.yml) in it:
   ```yaml
   services:
     tonearr:
       image: ghcr.io/espenost/tonearr:latest
       container_name: tonearr
       restart: unless-stopped
       ports:
         - "5056:5056"
       volumes:
         - ./data:/data
       environment:
         TZ: Europe/Oslo # set to your time zone
   ```
   If your NAS or server has a web UI for containers (Portainer, Container Station, ...), you can paste this in there instead.
2. **Choose where data is stored.** By default it goes in `./data` next to the compose file. To store it elsewhere, change the volume path for `/data`. You don't need to create the folder or set permissions: on start, the container makes it writable for the `node` user (uid 1000) the app runs as. If that fails, for example on some network shares, the log says so and how to fix it.
3. **Start it:**
   ```sh
   docker compose up -d
   ```
   With older Docker versions, use `docker-compose` with a hyphen instead. Check that it is running with `docker ps` and `docker logs -f tonearr`.
4. **Open `http://<host-ip>:5056` and sign in.** The first time, the sign-in page also asks for the **Emby address**, e.g. `http://192.168.1.50:8096`. Sign in with an Emby **administrator** account. This saves the address, and from then on everyone signs in with their Emby account.
5. **Fill in the rest under Settings**, where you land right after the first sign-in. Until it's done, administrators see a notice at the top of every page.
   - **Emby API key:** needed to see what is already in the library. Create it under *Emby Dashboard → Advanced → API Keys*.
   - **Lidarr:** needed to download requests, e.g. `http://192.168.1.10:8686`. The key is under *Lidarr → Settings → General*.
   - Click **Test connection**. For Lidarr, this fills in the root folder, quality profile and metadata profile as dropdowns.

> Only an Emby administrator can complete the first sign-in. Do it right after you start the container: until then, anyone who can reach the page could point Tonearr at an Emby server they control. Changes to the Emby connection in Settings are tested before they are saved, so you can't lock yourself out with a wrong address or key.

> **Addresses:** use the LAN IP of the Emby and Lidarr machines, not `localhost`. Inside the container, `localhost` is the container itself. If Emby runs on Windows, the Windows firewall must allow incoming traffic on port 8096 from the Tonearr host.

**Port 5056 in use?** Change the left-hand side of `ports:` in `docker-compose.yml`, e.g. `"5057:5056"`.

### Updating

```sh
docker compose pull
docker compose up -d
```

The data folder is kept. Image tags:

| Tag | What you get |
|---|---|
| `latest` | The newest release |
| `1.2.3` / `1.2` | A specific release, or the newest `1.2.x` – pin one of these to choose when you upgrade |
| `edge` | The newest unreleased code – may be unstable |

### Building from source

To build the image yourself instead of pulling it, clone the repository and run:

```sh
docker compose -f docker-compose.build.yml up -d --build
```

## Running without Docker

Requires Node.js 20 or newer. There are no dependencies to install.

```sh
cp .env.example .env   # optional – everything can also be set in the web UI
npm start
```

Data is stored in `./data` by default (`DATA_DIR`).

## Lidarr setup notes

- **Metadata profile:** Lidarr only knows about the release types included in the metadata profile. For users to request EPs and singles, the profile must include *EP* and *Single* (and optionally *Live* and *Compilation*). Otherwise those requests stay at "Waiting for Lidarr" and end up as "Failed" with an explanation.
- If root folder and profiles are set to "First available", the app uses the first root folder and the first profiles in Lidarr.
- New artists are added with *Monitor: None*. Only the selected albums are monitored. "Follow new releases" sets *Monitor New Albums: All* on the artist.
- Albums that are monitored in Lidarr but have no files can still be requested. A request starts a search for them, since Lidarr doesn't necessarily search for monitored albums on its own.

## Email notifications

Email is off until an administrator turns it on under **Settings → Email notifications**:

- **Mail server:** the SMTP server, encryption and port. Common choices are STARTTLS on port 587, SSL/TLS on port 465, or no encryption on port 25 (only for a relay on your own network). The server's certificate must be valid, so self-signed certificates are not accepted.
- **Username and password:** leave them empty if the server doesn't need sign-in. Gmail and Outlook need an *app password*, not your normal password.
- **Sender:** e.g. `Tonearr <you@example.com>`. Many providers only accept the address you sign in with.
- **Tonearr address:** used for links in the emails, e.g. `http://192.168.1.10:5056`.
- **Notify about new requests:** one or more addresses that get an email when a request needs approval. This only happens when *Approve requests automatically* is off.

Click **Send test email** to check the setup before saving.

Once email is on, every user gets a **Notifications** page. There they enter their email address and choose what to be told about: approved, declined, download started, downloaded, partly available, available or failed. Each kind of email is sent at most once per request. Email addresses are stored in `/data/db.json`.

## Discover

The start page has rows of suggestions:

- **New releases:** albums and EPs from the last 90 days, newest first.
- **Coming soon:** albums and EPs with a release date in the next 90 days. Requesting one monitors it in Lidarr, which grabs it once it is out.
- **More from artists you play:** albums you don't have by the artists you play most in Emby.
- **You might like:** the best-known albums by artists similar to the ones you play, that aren't on the server, in Lidarr or requested yet.
- **Missing from the collection:** for each artist on the server, their best-known studio album that you don't have, classics first.
- **Popular now:** the most played albums on ListenBrainz this month, one per artist.
- **Requested by others:** the latest albums other users have requested (without their names).
- **My recent requests.**

New and upcoming releases come from ListenBrainz' public list of fresh releases (fetched every 6 hours), and *Popular now* from its public monthly chart (every 24 hours). Tonearr only fetches those lists and filters them locally. A new release is shown when its main artist is in the Emby library (with a MusicBrainz ID), in Lidarr, or in a request here. Only albums and EPs are shown, including live albums and soundtracks. Singles, compilations, remixes and the like are left out. To switch the ListenBrainz rows off, untick **Settings → Discover → Show suggestions from ListenBrainz**.

*Missing from the collection* uses MusicBrainz: an album with many editions and reissues is usually a well-known one. Tonearr looks up the official studio albums of up to 300 artists – the ones requested here first, then the artists with the most albums in Emby – in the background at low priority, so searches always go first. With MusicBrainz' limit of one request per second, a large library takes a few minutes the first time. The answers are cached in `/data/artist-albums.json` and refreshed every 30 days; new artists are picked up within half an hour. Artists with more than 100 studio albums (classical composers, for example) are skipped, since there is no reliable way to rank them.

The two personal rows are different for each user. Tonearr reads the user's play counts and favourites from Emby (recent plays count double, and favourite artists, albums and tracks add to an artist's score) and takes their 25 top artists; only artists with a MusicBrainz ID count. Their albums come from MusicBrainz, ranked like *Missing from the collection*, and are looked up before the rest of the collection. Similar artists for the 10 top artists come from ListenBrainz (cached in `/data/similar-artists.json` for 30 days). Only the artist IDs are sent – never user names or play counts. A user who hasn't played anything in Emby doesn't get these rows. The first time, the suggestions take a few minutes to look up; until then the rows say so. *You might like* is switched off together with the other ListenBrainz rows.

An album is only shown once, on the first row that has it.

## Status from Emby

Emby reads the MusicBrainz IDs that Lidarr writes to the files. Matching uses the release group ID, then the release ID, and finally artist + album title for albums without IDs.

Some albums in Emby only have a release ID (one specific edition) and no release group ID. Tonearr looks up the release group for these in MusicBrainz in the background, about 50 albums per request, so even a large library is done in a minute or two. The answers are cached in `/data/release-groups.json`, so each album is only looked up once. Progress and results are shown under **Settings → Library and status**. Searches always go before these lookups. For the most reliable matching, let Lidarr write tags to the files (*Settings → Metadata → Write Metadata to Audio Files*) so Emby gets both IDs. After Lidarr has imported an album, it shows "Downloaded" until Emby has scanned the library. Consider enabling real-time monitoring for the music library in Emby.

## Environment variables (optional)

Settings are saved to `/data/settings.json` from the web UI. Environment variables are only used as initial values, and anything saved on the Settings page overrides them.

| Variable | Default | Description |
|---|---|---|
| `EMBY_URL` / `EMBY_API_KEY` | – | Can also be set in the web UI |
| `LIDARR_URL` / `LIDARR_API_KEY` | – | Can also be set in the web UI |
| `LIDARR_ROOT_FOLDER` | first | Root folder for music |
| `LIDARR_QUALITY_PROFILE_ID` | first | Quality profile ID |
| `LIDARR_METADATA_PROFILE_ID` | first | Metadata profile ID |
| `AUTO_APPROVE` | `true` | `false` means an administrator must approve requests |
| `MB_USER_AGENT` | generic | MusicBrainz asks for contact info here |
| `LISTENBRAINZ_ENABLED` | `true` | `false` hides the ListenBrainz rows on Discover (new, upcoming, you might like, popular) |
| `EMAIL_ENABLED` | `false` | Turn on email notifications |
| `SMTP_HOST` / `SMTP_PORT` | – / `587` | Mail server |
| `SMTP_SECURITY` | `starttls` | `starttls`, `tls` (port 465) or `none` |
| `SMTP_USER` / `SMTP_PASSWORD` | – | Sign-in to the mail server, if needed |
| `EMAIL_FROM` | – | Sender, e.g. `Tonearr <you@example.com>` |
| `ADMIN_EMAILS` | – | Comma-separated; told about requests that need approval |
| `APP_URL` | – | Tonearr's address, used for links in emails |
| `APP_NAME` | `Tonearr` | Site name |
| `PORT` | `5056` | |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `db.json` and `settings.json` are stored |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `WORKER_INTERVAL_SEC` | `30` | How often status is checked |
| `EMBY_INDEX_TTL_SEC` | `300` | How often the Emby library is re-read |

## Local testing without real servers

```bash
node dev/mock.js          # fake Emby (:18096), Lidarr (:18686) and mail server (:12525)
EMBY_URL=http://localhost:18096 EMBY_API_KEY=emby-key \
LIDARR_URL=http://localhost:18686 LIDARR_API_KEY=lidarr-key \
WORKER_INTERVAL_SEC=5 EMBY_INDEX_TTL_SEC=5 node src/server.js
```

Sign in as `admin`/`admin` or `alice`/`alice`. The mock server simulates search, download and the album appearing in Emby. To try email, set the mail server to `localhost`, port `12525`, encryption *None*. The emails are printed in the mock's terminal.

## Security

API keys and the mail password are never shown in plain text in the web UI. They are stored in `/data/settings.json`, so keep that folder private. The user's Emby password is only passed on to Emby. It is never stored, and the Emby session is logged out immediately. The app uses its own session cookie (HttpOnly, SameSite=Lax) and has basic protection against repeated sign-in attempts. If the app is reachable from outside your network, put it behind a reverse proxy with HTTPS.

## Releasing a new version (maintainers)

The image is built and published by GitHub Actions ([`.github/workflows/docker.yml`](.github/workflows/docker.yml)) to `ghcr.io/<owner>/<repo>`.

1. Update `version` in `package.json`, e.g. to `0.2.0`. It is the only place the version is set.
2. Commit, then tag and push:
   ```sh
   git tag v0.2.0
   git push origin main --tags
   ```
3. The workflow builds for `amd64` and `arm64` and publishes `0.2.0`, `0.2` and `latest`. Every push to `main` also publishes `edge`.

After the first publish, check under *GitHub → your profile → Packages → tonearr → Package settings* that the visibility is **Public**, so others can pull the image without signing in.

## License

[MIT](LICENSE)
