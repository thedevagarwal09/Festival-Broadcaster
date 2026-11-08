# 🪔 Festival Broadcaster

A free, self-hosted web app for sending festival greetings (Diwali, Eid, Christmas, New Year…) to your own
WhatsApp contacts. It links to your personal WhatsApp through the open-source multi-device protocol library
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys). It does not use the Meta Cloud API, Twilio or
any paid service. The database is a local SQLite file, and the app needs no Redis or external server.

> ⚠️ **Read this first.** Automating a personal WhatsApp account is against WhatsApp's Terms of Service. The
> built-in pacing (one message at a time, random 8–18 s gaps, typing simulation, cooldowns, spintax) makes a
> broadcast look much less like spam, but it **cannot guarantee your number won't be restricted or banned**. Only
> message people who know you and have your number saved, keep lists small, and consider using a secondary number.

---

## Project structure

```
.
├── package.json
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
2. **Wait for contacts.** WhatsApp sends your contacts in bursts after linking. This can take from a few seconds
   to a few minutes, and the list fills in by itself.
3. **Build groups.** Open *Contacts & Groups*, tick contacts, name the group (for example "Diwali - Family") and
   save it.
4. **Compose.** Pick a group and write the message with spintax and `{{name}}`. You can attach an image or
   video, then click *Review & send*.
5. **Watch it run.** *Live Dispatch* shows the progress bar and the live log, with Pause, Resume and Abort.

For a production build, run:

```bash
npm run build && npm start
```

## How it works

### Session handling (Module A)
- The browser generates a UUID `sessionId`, stores it in `localStorage` and sends it to the server with
  `init_session`. Socket.IO rooms keep each session's events separate.
- Auth state is stored with `useMultiFileAuthState` in `./sessions/{sessionId}/`. On server boot, every session
  that has finished pairing reconnects without a new QR scan.
- QR strings become base64 PNG data URLs (`qrcode`) and are pushed as `qr_code` events.
- On `connection === 'open'` the server emits `session_connected`. Contacts from `contacts.upsert`,
  `contacts.update` and `messaging-history.set` are upserted into SQLite. A real name is never overwritten
  with an empty one.
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
- The server binds to `127.0.0.1` because the app has no login of its own. Don't expose it to a network.
- `./sessions/` contains full access to your WhatsApp account. Never share or commit it.
- If the process dies after WhatsApp accepted a message but before SQLite recorded it, that one recipient may get
  the message twice after restart. This is rare, but it is the trade-off for crash-safe resumption.
- WhatsApp changes its protocol from time to time. If linking stops working, update Baileys
  (`npm i @whiskeysockets/baileys@latest`) and check its changelog.
- Set `BAILEYS_LOG_LEVEL=debug` in `.env` to see protocol logs.
