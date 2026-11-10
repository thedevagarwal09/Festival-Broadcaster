# 🎉 Festival Broadcaster

A free, self-hosted web app for sending greetings for any festival or occasion (Diwali, Holi, Eid, Christmas,
New Year, birthdays, anniversaries, wedding invitations…) to your own WhatsApp contacts. It links to your personal WhatsApp through the open-source multi-device protocol library
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys). It does not use the Meta Cloud API, Twilio or
any paid service. The database is a local SQLite file, and the app needs no Redis or external server.

> ⚠️ **Read this first.** Automating a personal WhatsApp account is against WhatsApp's Terms of Service. The
> built-in pacing (typing simulation, random gaps, rests and breaks, spintax) makes a broadcast look much less
> like spam, but it **cannot guarantee your number won't be restricted or banned**: restrictions mostly come
> from recipients reporting or blocking unexpected messages, and no pacing hides automation. Only
> message people who know you and have your number saved, keep lists small, and consider using a secondary number.

---

## Project structure

```
.
├── package.json
├── Dockerfile                   # production image (state lives in the /data volume)
├── docker-compose.yml           # Portainer / docker compose stack
├── .dockerignore                # keeps sessions, DB and .env out of the image
├── tsconfig.json
├── next.config.mjs
├── tailwind.config.ts
├── postcss.config.mjs
├── .env.example                 # copy to .env — DATABASE_URL, HOST, PORT, BAILEYS_LOG_LEVEL
├── prisma/
│   ├── schema.prisma            # UserSession, Contact, ContactGroup, BroadcastCampaign, QueueItem
│   └── dev.db                   # created by `npx prisma db push`
├── server/                      # Node backend (runs Next.js as a custom server on :3000)
│   ├── index.ts                 # Express + Socket.IO + Next.js bootstrap, crash recovery, shutdown
│   ├── db.ts                    # Prisma client (SQLite, WAL mode)
│   ├── realtime.ts              # Socket.IO room helpers
│   ├── socket-handlers.ts       # init_session / refresh_qr events
│   ├── serializers.ts           # DB rows → DTOs
│   ├── upload.ts                # multer storage in ./uploads
│   ├── routes/api.ts            # REST API: contacts, groups, campaigns, pause/resume/abort
│   ├── services/mediaCompressor.ts  # sharp + ffmpeg compression pipeline
│   ├── services/mediaJobs.ts        # background compression jobs with live progress
│   ├── services/scheduler.ts        # node-cron scheduler: scheduled starts, quiet hours
│   ├── services/quietHours.ts       # quiet-hours settings and time-window maths
│   ├── whatsapp/session-manager.ts  # Module A: Baileys sockets, QR stream, reconnect, contact sync
│   ├── queue/dispatcher.ts      # Module C: SQLite-backed serial dispatcher with anti-ban pacing
│   └── utils/                   # sleep, errors, jid helpers
├── src/                         # Next.js App Router frontend
│   ├── app/{layout.tsx,page.tsx,globals.css}
│   ├── components/
│   │   ├── QrLogin.tsx          # live QR stream, auto-refresh, expiry handling
│   │   ├── Dashboard.tsx        # header, connection banner, tabs
│   │   ├── ContactsManager.tsx  # search/filter contacts, build & edit groups
│   │   ├── BroadcastComposer.tsx# group picker, editor, spintax tips, media preview
│   │   ├── SummaryModal.tsx     # ETA, rate-limit and ban-risk warnings, confirmation
│   │   └── LiveTerminal.tsx     # progress bar, live log feed, pause/resume/abort
│   └── lib/
│       ├── types.ts             # shared DTOs + typed Socket.IO events
│       ├── spintax.ts           # {{variables}} + nested {a|b} spintax (used by UI preview *and* server)
│       ├── pacing.ts            # pacing constants + ETA maths (used by UI *and* dispatcher)
│       ├── api.ts, socket.ts, session-id.ts, format.ts
├── sessions/                    # Baileys auth state, one folder per session (keep private!)
└── uploads/                     # attached images/videos
```

## Requirements

- **Node.js 20 or newer** (`node -v`). Install it from <https://nodejs.org> (the LTS build).
- A phone with WhatsApp that can use **Linked devices**.

## Run it on http://localhost:3000

```bash
cp .env.example .env
```

```bash
npm install
```

```bash
npx prisma db push
```

```bash
npm run dev
```

Then open <http://localhost:3000>:

1. **Link WhatsApp.** On your phone, go to WhatsApp → Settings → Linked devices → Link a device, and scan the QR
   code. A new code appears about every 20 s. If the codes run out, click "Generate new code".
2. **Wait for contacts.** Right after linking, the app pulls your address book once, which usually
   takes a few seconds. Chats and messages are never downloaded. Contacts are stored on the server,
   so later restarts don't sync again, and new contacts you save on your phone appear by themselves.
   *Sync now* on the Contacts page pulls changes on demand.
3. **Build groups.** Open *Contacts & Groups*, tick contacts, name the group (for example "Diwali - Family") and
   save it. To reorganise, open a group, tick contacts and use *Move* (to another group), *Add*
   (also put them in another group) or *Remove*.
4. **Compose.** Pick a group and write the message with spintax and `{{name}}`. You can attach an image or
   video, which is compressed automatically (see below). Your draft is saved as you type, so a reload
   or a different browser never loses it.
5. **Send now or schedule.** Choose *Start right away* or *Schedule for later*, for example Diwali at
   07:00. The server starts it on its own, so the browser can be closed.
6. **Watch it run.** *Live Dispatch* shows the completion bar, Total targets / Dispatched /
   Failed, a time-left estimate and the live log, with Pause, Resume and Abort.

For a production build, run:

```bash
npm run build && npm start
```

## Deploy with Docker / Portainer

The repo includes a `Dockerfile` and a `docker-compose.yml`, so a Linux server running Portainer can
build and run it straight from GitHub.

### 1. Create the stack in Portainer
1. Go to **Stacks → Add stack**, name it `festival-broadcaster`, and choose **Repository**.
2. Fill in the repository settings:
   - **Repository URL:** `https://github.com/thedevagarwal09/Festival-Broadcaster`
   - **Repository reference:** `refs/heads/main`
   - **Compose path:** `docker-compose.yml`
   - **Authentication:** leave it off while the repo is public.
3. Optionally, under **Environment variables**, set any of these:

   | Variable | Default | What it does |
   |---|---|---|
   | `PUBLISH_PORT` | `3005` | Port on the server, e.g. `http://<server-ip>:3005` |
   | `TZ` | `Asia/Kolkata` | Time zone for logs and campaign names |
   | `BAILEYS_LOG_LEVEL` | `silent` | `info` / `debug` for WhatsApp protocol logs |
   | `ALLOWED_ORIGINS` | *(empty)* | Your public address, e.g. `https://wishes.example.com`. Only needed behind a reverse proxy that rewrites the `Host` header |

4. Click **Deploy the stack**. The first build takes a few minutes.
5. Open `http://<server-ip>:3005` and scan the QR code. A fresh server starts with
   no data: your contacts sync from WhatsApp, and you create groups again.

To pick up new commits later, open the stack and click **Pull and redeploy**. You can also turn on
**GitOps updates** to redeploy automatically.

**Behind a reverse proxy or a domain name** (Nginx Proxy Manager, Traefik, Caddy, Cloudflare Tunnel):
- Forward **all paths**, including `/socket.io/`, to `http://<server-ip>:3005`. If the proxy
  supports WebSockets, turn them on (in Nginx Proxy Manager, tick *Websockets Support*). Without
  WebSockets the app falls back to HTTP long-polling, which still works.
- If the page stays on "Connecting to the server…", set `ALLOWED_ORIGINS` to the exact address in
  your browser bar (e.g. `https://wishes.example.com`) and redeploy.

### 2. Where your data lives
Everything is in the named volume **`festival-data`**, mounted at `/data`:

| Path | Contents |
|---|---|
| `/data/app.db` | Contacts, groups and campaigns (SQLite) |
| `/data/sessions/` | WhatsApp login keys. **Treat like a password.** |
| `/data/uploads/` | Attached images and videos |

Redeploying or updating the stack keeps the volume. Deleting the volume erases the data and unlinks
the app. To back it up, run this on the server:

```bash
docker run --rm -v festival-broadcaster_festival-data:/data -v "$PWD":/backup busybox tar czf /backup/festival-data.tgz -C /data .
```

### 3. Security on a server
- **The app has no login.** Anyone who can open `http://<server-ip>:3005` can see your contacts
  and send WhatsApp messages as you. Only make the port reachable from your own LAN or VPN.
- **Don't open port 3005 on your router or firewall to the internet.** If you need remote access,
  use a VPN (WireGuard, Tailscale) or a reverse proxy that adds its own login.
- **One WhatsApp account per instance.** If you also run the app on your laptop, unlink one of
  them, or each will keep its own separate contacts and campaigns.

## Occasions, templates and e-cards

- **20 occasions:**
  - **Indian:** Diwali, Holi, Raksha Bandhan, Janmashtami, Ganesh Chaturthi, Navratri, Dussehra, Makar Sankranti.
  - **Global & religious:** New Year, Christmas, Easter, Thanksgiving, Eid ul-Fitr, Eid ul-Adha.
  - **National:** Republic Day, Independence Day.
  - **Personal:** Birthday, Anniversary, Wedding Invitation, General Announcement.

  They're defined in [`src/lib/occasions.ts`](src/lib/occasions.ts).
- **Templates:** every occasion has templates in **English, हिन्दी and Hinglish**, with spintax and `{{first_name}}`.
  Switching occasion or language replaces the message only while it's still an unedited template. *Use template*
  always replaces it.
- **Upcoming detector:** the dashboard suggests the nearest festival within two months, with a one-click *Start a …
  broadcast*. The composer shows the next four as "Coming up" chips.
- **Dates:** fixed-date occasions are exact, and Easter and Thanksgiving are calculated. Festivals that follow lunar
  calendars (Diwali, Holi, Eid…) move each year and can differ by a day between regions. Their 2026–2028 dates are a
  best-effort table, marked **≈** in the app, so check them before scheduling and extend the table for later years.
- **E-cards:** *Create a … e-card* draws a 1080×1350 card with sharp. It has an occasion-specific motif (diyas, colour
  splashes, fireworks, bells, kites, tricolour, crescent moon, flowers, leaves, balloons, hearts, mandala, confetti),
  a title in English or Hindi and an optional sign-off. Everyone gets the same card (it's uploaded once), and the
  caption stays personalised. The Docker image includes Latin and Devanagari fonts for this.

## Sending speed

Choose a pacing preset in the composer. The time estimates use the same numbers the sender does.

| Preset | Rhythm | ~300 contacts |
|---|---|---|
| **Careful** (default) | One by one, 8–18 s apart, 1-minute break every 25 | ~1 h 30 m |
| **Balanced** | Bursts of 3–5 messages 3–6 s apart, then a 20–40 s rest; 90 s break every 40 | ~1 h 15 m |
| **Fast** | Bursts of 3–6 messages 2–4 s apart, then a 20–45 s rest; 90 s break every 50 | ~1 h 5 m |

**Attachments are uploaded once per campaign.** The socket has a Baileys `mediaCache`, so the first send encrypts
and uploads the file. Every later send reuses the stored pointer (CDN URL, `mediaKey`, `fileEncSha256`, `fileSha256`,
length, thumbnail) without uploading again. Entries expire after 6 hours, and a failed send drops the entry so the next
send re-uploads.

The app deliberately does **not** add invisible "hash randomiser" characters. WhatsApp messages are end-to-end
encrypted, so WhatsApp's servers never see or hash the text, and every encrypted message is already unique. Spintax is
there for the people reading, not for filters.

## Media compression

Every attachment goes through a compression step before it can be queued, so WhatsApp never has to
receive a huge upload once per recipient (which causes socket timeouts and "payload too large"
errors). The code is in `server/services/mediaCompressor.ts`.

| | Accepted | Output |
|---|---|---|
| **Images** (sharp) | JPEG, PNG, WebP up to 25 MB | JPEG, at most 1920×1080 (1080×1920 for portrait), quality 80→75, under 800 KB. EXIF/GPS metadata is removed after applying the photo's rotation, and transparency becomes white |
| **Videos** (ffmpeg via `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg`) | MP4, MOV, MKV up to 500 MB | H.264 + AAC in MP4, at most 720p (short side) at ≤ 30 fps. Short clips use one CRF 25 pass with a bitrate cap. Longer clips use two passes at a bitrate computed for about 14 MB. Anything over 16 MB is re-encoded once at a lower bitrate. Clips too long to fit at watchable quality (about 5+ minutes) are refused with a clear message |

**Compress or send the original.** Above the attach button you choose *Compress (recommended)* or
*Send original*. The choice is remembered in your browser. *Send original* stores the file
byte-for-byte: no resizing or re-encoding, and photo metadata such as location stays in it. It
accepts what WhatsApp sends as a normal photo or video: JPG/PNG/WebP up to 16 MB and MP4 up to
64 MB. MOV/MKV still need compressing. Large originals are uploaded once per recipient, so they
send more slowly.

Compression runs as a background job with live progress, so a slow video never hits a browser or
proxy timeout. Videos are encoded one at a time to protect the server's CPU. The original upload is
deleted once it's processed. If you use a reverse proxy, let it accept uploads of up to 500 MB (in
Nginx Proxy Manager: *Advanced → `client_max_body_size 500m;`*).

## Scheduling and quiet hours

`server/services/scheduler.ts` runs every minute on the server (node-cron):

```
SCHEDULED ──start time reached──▶ PROCESSING ──▶ COMPLETED
                                     │  ▲
                 quiet hours begin   ▼  │  quiet hours end (e.g. 07:00)
                              QUIET_HOURS_PAUSED
PAUSED = paused by you (or WhatsApp unlinked); never resumed automatically.
```

- **Quiet hours** default to **23:00–07:00** in the server's time zone (`TZ`, Asia/Kolkata in Docker).
  Change them on the Compose screen. Changes apply immediately.
- The sender also checks quiet hours **right before each message**, so nothing goes out between
  scheduler ticks.
- A scheduled campaign whose start time falls inside quiet hours waits until they end.
- *Start now* on a scheduled campaign skips the wait. *Hold* keeps a quiet-hours pause from
  resuming on its own.

## Analytics

The dashboard shows Total targets, Dispatched and Failed. Time left uses the campaign's real average gap between
messages (jitter and cooldowns included), falling back to the pacing settings until two messages
have gone out.

## Unlink and erase my data

**Erase my data** (in the dashboard header, and under the QR code) deletes everything belonging to
the person using it, and nothing else, so it is safe on a server shared by many people. You must
type `ERASE` to confirm. "Their data" means the session ids this browser has used (it remembers
earlier ones, since a new id is issued after every unlink), plus every session of the WhatsApp
number linked to them. It then:

1. stops their sending (the message in flight finishes first)
2. unlinks their WhatsApp and deletes its login keys
3. deletes their contacts, groups, campaigns, logs and draft, then compacts the database so the
   deleted rows don't linger in the file
4. deletes the attachments and e-cards they added (a file another person's campaign also uses is
   kept)

Server settings such as quiet hours are not touched. Chats and contacts on the phone are not
touched. If the account was offline, WhatsApp can't confirm the unlink: the result screen says so,
and it can be removed on the phone under *Settings → Linked devices*. Container logs
(`docker logs`) are not part of the app's data.

## How it works

### Session handling (Module A)
- The browser generates a UUID `sessionId`, stores it in `localStorage` and sends it to the server with
  `init_session`. Socket.IO rooms keep each session's events separate.
- Auth state is stored with `useMultiFileAuthState` in `./sessions/{sessionId}/`. On server boot, every session
  that has finished pairing reconnects without a new QR scan.
- QR strings become base64 PNG data URLs (`qrcode`) and are pushed as `qr_code` events.
- On `connection === 'open'` the server emits `session_connected`.
- **Contacts, not messages.** Chat history is never downloaded: no chats, no messages, not even
  the profile-name list, so linking is quick and reconnects skip Baileys' 20-second wait for
  history. The address book (the `critical_unblock_low` app-state collection) is pulled directly,
  and WhatsApp profile names still arrive live.
- **Stored, not re-synced.** Contacts live in SQLite, and the time of the last address-book pull is
  saved (`UserSession.contactsSyncedAt`). On reconnect the pull is skipped if it's under 6 hours old.
  New or edited contacts still arrive live through WhatsApp's `server_sync` push, and later pulls only
  fetch what changed since the stored version.
- Only new or changed contacts are written, so a full re-sync of ~1,800 unchanged contacts is a few
  read queries. A real name is never overwritten with an empty one.
- Transient drops reconnect with exponential backoff (1 s up to 30 s). `restartRequired`, which WhatsApp sends
  right after a scan, reconnects at once. `loggedOut` wipes the auth folder, pauses running campaigns and sends
  the browser back to a fresh QR. `connectionReplaced` stops instead of fighting the other client.

### Dispatcher (Module C)
- `QueueItem` rows in SQLite are the queue. Each session has one worker loop, so messages go out strictly one at
  a time.
- Each message is claimed atomically (`PENDING → PROCESSING`). After a crash, `PROCESSING` items go back to
  `PENDING` and running campaigns restart automatically.
- Per recipient, the worker sends a `composing` presence, waits 2–3.5 s, sends `paused`, then sends the message.
- Between recipients it waits a random 8–18 s. After every 25 dispatched messages it pauses for 60 s instead.
- Variables (`{{name}}`, `{{first_name}}`, `{{phone}}`; the name falls back to "Friend") are filled in first.
  Spintax, including nested groups, is resolved per recipient after that, so each message hash differs.
- If WhatsApp disconnects in the middle of a send, the item goes back to the queue and is retried after
  reconnect. Other errors mark it `FAILED` with the reason.
- Pause takes effect before the next message. Abort marks every unsent item as `CANCELLED`.

All pacing values live in [`src/lib/pacing.ts`](src/lib/pacing.ts).

## Notes and limits
- The app has no login. Run locally, the server binds to `127.0.0.1` so only your computer can reach it.
  In Docker it listens on the published port, so keep that port on a trusted network.
- `./sessions/` contains full access to your WhatsApp account. Never share or commit it.
- If the process dies after WhatsApp accepted a message but before SQLite recorded it, that one recipient may get
  the message twice after restart. This is rare, but it is the trade-off for crash-safe resumption.
- WhatsApp changes its protocol from time to time. If linking stops working, update Baileys
  (`npm i @whiskeysockets/baileys@latest`) and check its changelog.
- Set `BAILEYS_LOG_LEVEL=debug` in `.env` to see protocol logs.
