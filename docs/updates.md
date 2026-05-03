# Roadmap — Private Chat

## Fase 1 — Scalabilita & Security (COMPLETATA)
- Dual DB: SQLite default + Postgres via `DB_DRIVER=pg`
- Migrazioni SQL versionate, Redis fallback in-memory
- Async scrypt, primo utente admin, session TTL
- Rimossi bot esterni, admin via sessione, upload protetto
- Prometheus /ready /metrics, pino logging
- Test: auth, files, security

## Fase 2 — Chat robustezza & UX base (COMPLETATA)
- Reply/thread (`reply_to`), reactions sync WS real-time
- Edit/delete propagate a tutti i device via WS
- Offline queue client-side con retry e deduplicazione `client_msg_id`
- Responsive CSS, tema scuro/chiaro persistente

## Fase 3 — Mobile nativo & Push (COMPLETATA)
- Capacitor push FCM/APNs, deeplink `privatechat://`
- Background sync queue, badge contatore
- Biometric lock FaceID/fingerprint

## Fase 4 — Chiamate di gruppo WebRTC (COMPLETATA)
- Group call signaling WS retro-compatibile
- Mesh default, SFU ready via env
- Screen share, mute/unmute, dominant speaker
- Grid layout adattivo

## Fase 5 — Storage & media (COMPLETATA)
- S3 presigned per file > 10MB, fallback locale
- Thumbnail server-side sharp, cache Redis
- Signed download URLs 15min
- Cleanup orfani e retention 90gg

## Fase 6 — Final polish & operations (COMPLETATA)
- E2E Playwright tests (registrazione, login, chat, call)
- Sentry/Pino error tracking, alerting
- Rate-limit distribuito Redis su login/reg/admin
- CI GitHub Actions, README + ARCHITECTURE.md

---

## Extra — consigliati oltre le 6 fasi (per impatto)

1. **Client-side search IndexedDB** — cerca nei messaggi locali senza toccare server (E2EE compliant). Alto impatto UX, costo zero.
2. **Captcha / proof-of-work registrazione** — mitiga spam account. Env `HCAPTCHA_*`.
3. **Anti-replay WS** — aggiungi `nonce`+`timestamp` a ogni messaggio, server scarta duplicati (cache Redis 10min). Prevents replay da server compromesso.
4. **X3DH + prekeys** — forward secrecy reale. Tabelle gia pronte, serve implementazione client.
5. **Multi-device vero** — linked devices con session key sync, non solo login multi-browser.
6. **Encrypted backup** — export JSON cifrato con passphrase-derived key (ora e plaintext metadata).
7. **Log retention auto-purge** — GDPR: non tenere IP/audit oltre 90 giorni. Cron giornaliero.
8. **Certificate pinning** — Capacitor client per certificati custom / self-hosted.
9. **Zero-downtime deploy** — graceful WS draining prima del restart (Railway lo fa parzialmente, ma non controllato).
10. **Keyboard shortcuts** — `Esc` chiude modali, `Ctrl+K` cerca, `/` focus chat.
