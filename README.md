# Tonearr

A simple, Seerr-like request site for music.

- **Sign in with your Emby account.** Emby administrators are administrators here too.
- **Search MusicBrainz** for artists, albums and songs.
- **Artist page** with albums, EPs, singles and other releases. Pick what you want, click "Request", and optionally tick "Follow new releases".
- **Lidarr** adds the artist without monitoring anything, then monitors and searches only for the albums you picked.
- **Status** comes from Lidarr (searching, downloading with %, downloaded) and from the Emby library (available). Anything already in Emby is marked "Available" in search and can't be requested again.
- **No "Various Artists" or "[unknown]".** Compilations credited to Various Artists, and releases by MusicBrainz' placeholder for an unknown artist, are hidden from search and can't be requested, since Lidarr would add them as one huge artist.
- **Approval** is optional (`AUTO_APPROVE`). Administrators can approve, decline, retry and delete requests.
- The app has no dependencies, just Node.js. Data is stored in a single JSON file (`/data/db.json`).

## Architecture

```
 Browser ──► Tonearr (:5056)
               ├─► Emby                sign-in + library index (every 5 min)
               ├─► MusicBrainz         search / artist / album list (max 1 req/sec, cached)
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
| `APP_NAME` | `Tonearr` | Site name |
| `PORT` | `5056` | |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `db.json` and `settings.json` are stored |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `WORKER_INTERVAL_SEC` | `30` | How often status is checked |
| `EMBY_INDEX_TTL_SEC` | `300` | How often the Emby library is re-read |

## Local testing without real servers

```bash
node dev/mock.js          # fake Emby (:18096) and Lidarr (:18686)
EMBY_URL=http://localhost:18096 EMBY_API_KEY=emby-key \
LIDARR_URL=http://localhost:18686 LIDARR_API_KEY=lidarr-key \
WORKER_INTERVAL_SEC=5 EMBY_INDEX_TTL_SEC=5 node src/server.js
```

Sign in as `admin`/`admin` or `alice`/`alice`. The mock server simulates search, download and the album appearing in Emby.

## Security

API keys are never shown in plain text in the web UI. They are stored in `/data/settings.json`, so keep that folder private. The user's Emby password is only passed on to Emby. It is never stored, and the Emby session is logged out immediately. The app uses its own session cookie (HttpOnly, SameSite=Lax) and has basic protection against repeated sign-in attempts. If the app is reachable from outside your network, put it behind a reverse proxy with HTTPS.

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
