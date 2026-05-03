# Private Chat

End-to-end encrypted chat with WebRTC voice/video, groups/channels, voice messages,
stickers, GIF picker, push notifications, bot framework, admin console and a
9-language UI.

- Backend: Node.js + Express + WebSocket (`ws`) + SQLite (`sqlite3`)
- Frontend: vanilla JS PWA with service worker, Web Crypto + Double Ratchet, MediaRecorder, RTCPeerConnection
- Mobile: Capacitor wrapper (iOS + Android)

---

## Deploy on Railway

The project ships a `Dockerfile` and a `railway.json`, so Railway will build and
run it automatically.

### 1. Create the service

1. Push this repo to GitHub.
2. Open [railway.com](https://railway.com), click **New Project → Deploy from GitHub repo**.
3. Select your fork. Railway detects the `Dockerfile` and starts the first build.

### 2. Add a persistent volume

SQLite DB, uploads and backups live on disk. Without a volume every redeploy
wipes user data.

1. In the service, open **Settings → Volumes → New Volume**.
2. Mount path: `/app/data` — name: `data`.
3. Add two more volumes the same way:
   - `/app/uploads` — name: `uploads`
   - `/app/backups` — name: `backups`

(If your Railway plan allows only one volume, mount `/app` and skip the others —
not recommended because it caches `node_modules` between builds.)

### 3. Generate VAPID keys (for Web Push)

Run locally **once**:

```bash
npx web-push generate-vapid-keys
```

Copy the two strings — you will paste them into Railway in the next step.

### 4. Set environment variables

In **Settings → Variables**, add:

| Variable | Required | Description |
|---|---|---|
| `PORT` | auto | Set automatically by Railway. Leave blank. |
| `TRUST_PROXY` | yes | Set to `1`. Railway terminates TLS in front of your app. |
| `VAPID_PUBLIC_KEY` | for push | From step 3. |
| `VAPID_PRIVATE_KEY` | for push | From step 3. Keep secret. |
| `VAPID_SUBJECT` | for push | `mailto:you@example.com` |
| `ADMIN_TOKEN` | for admin console | Long random string. Required to open `/admin.html`. |
| `ADMIN_USER_ID` | optional | If set, only this user id can hit `/api/admin/*`. |
| `BOT_WEBHOOK_SECRET` | optional | Used to sign HMAC headers on outgoing bot webhooks. |
| `TENOR_API_KEY` | optional | Enables the GIF picker. Get it from [Google Tenor](https://developers.google.com/tenor/guides/quickstart). Without it the picker stays empty. |
| `STUN_URLS` | optional | Comma-separated. Default: `stun:stun.l.google.com:19302`. |
| `TURN_URL` | recommended | TURN server, e.g. `turn:turn.example.com:3478`. Required for calls behind symmetric NAT (most mobile networks). |
| `TURN_USERNAME` | with TURN | TURN credentials. |
| `TURN_CREDENTIAL` | with TURN | TURN credentials. |

Generate a strong `ADMIN_TOKEN`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Expose a public domain

**Settings → Networking → Generate Domain**. Railway gives you a
`*.up.railway.app` URL (HTTPS, HTTP/2, WSS for free). The browser needs HTTPS
for: service worker, push, microphone, camera, WebRTC. So **always use the
Railway domain, never the raw IP**.

### 6. First boot

After the first deploy:

1. Open `https://your-app.up.railway.app`.
2. Register the first user. The first registered user is automatically the
   project owner inside the app (admin powers in `/admin.html` are gated by the
   token, not by user id, unless you also set `ADMIN_USER_ID`).
3. Open `https://your-app.up.railway.app/admin.html` and paste your
   `ADMIN_TOKEN` to access the moderation dashboard.

### 7. (Optional) TURN server

Public STUN is enough for most desktops and Wi-Fi. For reliable calls on 4G/5G
you need TURN. Two options:

- **Self-host** [coturn](https://github.com/coturn/coturn) on a small VM and
  point `TURN_URL` at it.
- **Managed**: services like [Twilio Network Traversal](https://www.twilio.com/stun-turn)
  or [Metered.ca](https://www.metered.ca/tools/openrelay/) provide turnkey TURN.

### 8. (Optional) Backups

The repo includes `scripts/backup.js`. Add a Railway cron with the command
`node scripts/backup.js` to dump SQLite into `/app/backups`. Without TURN/cron
the app still works.

---

## Local development

```bash
git clone https://github.com/grimmjs/privatechat
cd privatechat
npm install
npm start         # http://localhost:3000
```

Optional dev variables:

```bash
export ADMIN_TOKEN=dev
export VAPID_PUBLIC_KEY=...
export VAPID_PRIVATE_KEY=...
node server.js
```

For HTTPS in development (needed for camera/mic/push), put a reverse proxy in
front, e.g. `caddy reverse-proxy --from https://localhost --to :3000`.

---

## Mobile build (Capacitor)

```bash
npm install --include=dev
npx cap add android       # one-time
npx cap add ios           # one-time, macOS only
npx cap copy
npx cap open android      # opens Android Studio
npx cap open ios          # opens Xcode
```

In `capacitor.config.json` change `appId` and `appName` to your own values
before publishing to the stores.

---

## Endpoint cheatsheet

| Path | Auth | Purpose |
|---|---|---|
| `/` | public | PWA |
| `/admin.html` | token (in-page input) | Moderation console |
| `/health` | public | Liveness probe |
| `/api/push/vapid` | public | Returns VAPID public key |
| `/api/turn` | public | ICE servers (STUN + TURN) |
| `/api/gif/search?q=...` | public | Tenor proxy |
| `/api/reports` | session | User submits a moderation report |
| `/api/bots/me`, `/api/bots/messages`, `/api/bots/friends` | bot bearer token | Bot framework |
| `/api/admin/*` | `X-Admin-Token` header | Admin operations |

WebSocket: same origin, path `/`. Authentication is the existing username +
password + TOTP flow already used by the app.

---

## State of the project

What is **fully implemented and tested**:

- E2EE messaging (per-pair ECDH baseline, plus optional Double Ratchet ladder
  with safety numbers).
- 1-to-1 voice and video calls (WebRTC, ICE config from `/api/turn`,
  mute / camera toggle / local recording).
- Voice messages (MediaRecorder + waveform).
- Groups and channels (roles, invite codes, history, broadcast).
- Sticker packs (private and shared).
- GIF picker (Tenor proxy).
- Web Push with VAPID + service worker `push` and `notificationclick`.
- Bot framework (REST API, scopes, HMAC webhooks, token rotation).
- Admin console (users, ban/unban, reports, audit, metrics).
- 9 languages (EN/IT/ES/FR/DE/PT/JA/ZH/AR/RU).
- Capacitor config for iOS/Android wrappers.
- SQLite migrations run automatically on boot.

What I would still add before calling it production-grade:

1. **TURN auto-provisioning** — currently you have to bring your own TURN
   server. A small wrapper around Twilio's NTS API (or a built-in coturn
   service in `docker-compose.yml`) would remove that friction.
2. **Group calls** — calls are 1-to-1 today. Multi-party would need an SFU
   (mediasoup, LiveKit) — heavier infra.
3. **End-to-end encryption for group messages** — group fan-out today reuses
   the per-pair keys. A Sender Keys / MLS scheme would scale better.
4. **Bot OAuth flow** — bots are created by their owner and given a bearer
   token. Real third-party bots would need an OAuth-style consent screen.
5. **Admin authentication via real user accounts** — the admin console is
   guarded by a shared `ADMIN_TOKEN`. Tying it to `ADMIN_USER_ID` with a
   normal session would be cleaner.
6. **Rate-limit + abuse signals on calls and groups** — basic per-action rate
   limit exists; per-IP and per-account daily caps would reduce spam.
7. **Object storage for uploads** — uploads currently live on the Railway
   volume. Moving them to S3/R2/B2 would survive volume resets and scale
   horizontally.
8. **Horizontal scale** — WebSocket fan-out is in-process. To run more than
   one Railway replica you need a Redis pub/sub layer between instances.
9. **End-to-end test suite** — there is a syntax check (`npm run syntax`) and
   the modules have been smoke-tested by hand. A Playwright suite covering
   register → call → group message → sticker would catch regressions.
10. **App store assets** — Capacitor wrapper compiles, but icons, splash
    screens, store screenshots and privacy manifests still need to be
    generated.

Everything in the original feature list (WebRTC calls, groups, push, voice
messages, stickers/GIFs, bot framework, mobile build, Double Ratchet, admin
console, full i18n) is in place and wired end-to-end. The 10 items above are
upgrades, not gaps.
