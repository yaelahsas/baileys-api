# Production Issues Fix Plan

Date: 2026-08-06
Status: ✅ P0/P1 code fixes implemented; staging/load validation pending

> **Implemented (Issue 1 — 2026-08-06, all code fixes):**
> - Indexed SQLite message store (`store/sqlite-store.js`) with cursor and date-range queries
> - Runtime selector `MESSAGE_STORE_TYPE=sqlite|memory` (default `memory` for rollback compatibility)
> - One-time migration from existing `<session>_store.json` when the SQLite database is empty
> - Automatic retention pruning via `MESSAGE_RETENTION_DAYS` (default 90 days, `0` disables)
> - SQLite WAL + `synchronous=NORMAL`, with `(jid, timestamp, id)` and `(jid, id)` indexes
> - Docker bind mount narrowed from the full repository to `./sessions:/app/sessions`
> - Regression tests for range/cursor query, pruning, and one-time migration

> **Implemented (Issue 2 — 2026-08-06, all fixes):**
> - LID extraction fallbacks (`imageMessage/videoMessage/documentMessage.contextInfo.participant`) in `commandHandler.js`
> - Store-based sender resolution (`resolveSenderFromStore`)
> - `SENDER_UNRESOLVED` sentinel + auto-retry (`retrySenderUnresolved`, 3s delay, max 3 attempts) in `whatsapp.js`
> - Hardened `handleGroupCommands` auth with the same fallback chain
>
> **Implemented (Issue 1 — 2026-08-06, partial):**
> - Date-range filter: `GET /messages?from=&to=` (unix sec/ms or ISO) filtered in `store/memory-store.js loadMessages` before sort/slice
> - `limit` now parsed & capped (1–500) in `controllers/getMessages.js`
> - Route validation for `from`/`to` in `routes/chatsRoute.js`
> - Completed by the all-code-fixes implementation above

---

## Issue 1: Slow Log Loading from January 2026 (Docker)

### Root Cause Analysis

| Factor | Impact |
|--------|--------|
| `store/memory-store.js:949-958` — `loadMessages()` converts ALL messages to array, sorts, then slices on every call | O(N log N) per request; with 150 msgs × N chats, repeated on every pagination |
| `sessionManager.js:531` — `maxMessagesPerChat: 150` limits per-chat but not total; many groups = large store file | Store JSON grows unbounded (150 × N chats) |
| `docker-compose.yaml:25` — 512MB memory limit + bind mount `./:/app` on Windows | Store file writes every 10s (autoSaveInterval) + large JSON parse on startup → GC pressure, OOM risk |
| `APP_WEBHOOK_FILE_IN_BASE64=false` (default) but if enabled → base64 media in store = massive file | |

### Target Fixes

| Priority | Fix | File(s) | Effort |
|----------|-----|---------|--------|
| P0 | **Cursor-based DB query** — Replace in-memory sort/slice with SQLite index lookup | New `store/sqlite-store.js` + `sessionManager.js` | 3-4h |
| P0 | **Date-range filter on API** — Add `from`, `to` query params to `GET /messages` | `routes/chatsRoute.js`, `controllers/getMessages.js` | 1h |
| P1 | **Store pruning** — Auto-delete messages older than N days (configurable) | `store/memory-store.js` or new SQLite store | 1h |
| P1 | **Remove bind mount for store file** — Use Docker volume for `sessions/` only | `docker-compose.yaml` | 0.5h |
| P2 | **Lazy store load** — Don't load full store on startup; load on first message request | `sessionManager.js`, `whatsapp.js` | 1h |

### Recommended Approach: SQLite Message Store

```
store/
├── memory-store.js      (current, keep for fallback/compat)
└── sqlite-store.js      (NEW — uses better-sqlite3, same API)
```

**Why SQLite:**
- `better-sqlite3` already a dependency (used by `journalQueue.js`)
- Cursor + date range = indexed queries (O(log N) vs O(N log N))
- Survives restart, no full JSON parse
- Memory footprint: constant, not O(total_messages)
- Same `loadMessages(jid, limit, cursor)` interface → zero controller changes

**Schema:**
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  jid TEXT NOT NULL,
  fromMe INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  message TEXT NOT NULL,  -- JSON string
  indexedAt INTEGER NOT NULL
);
CREATE INDEX idx_messages_jid_ts ON messages(jid, timestamp DESC);
CREATE INDEX idx_messages_jid_id ON messages(jid, id);
```

**Migration path:**
1. Implement `sqlite-store.js` with identical public API as `memory-store.js`
2. Add env `MESSAGE_STORE_TYPE=sqlite|memory` (default: memory for compat)
3. In `sessionManager.js`, switch based on env
4. One-time migration script: read old JSON → bulk insert to SQLite

---

## Issue 2: First Image Send Fails "Gagal mengidentifikasi pengirim"

### Root Cause Analysis

| Location | Problem |
|----------|---------|
| `commandHandler.js:787-808` (`handleGroupImageMessage`) | LID extraction chain: `customLid` → `quoted participant` → `msg.key.participant` → `msg.key.participantAlt` → `isPersonalJid(remoteJid)` |
| `whatsapp.js:188` (`handleMessageUpsert`) | ALL group messages route through `handleGroupCommands` first; if not a command → `handleGroupImageMessage` |
| `commandHandler.js:284` (`handleGroupCommands`) | Authorization check uses `msg.key.participant || msg.key.participantAlt || msg.key.remoteJid` |

**Why first fails, second works:**
- On **first upsert** of a new message in a group, Baileys (v7) may deliver the message with `key.participant` **undefined** (race: participant resolution async / LID mapping not yet cached)
- `extractPhoneNumber(undefined)` → `''` → `isAuthorized('')` → false OR LID extraction throws "Tidak dapat mengidentifikasi pengirim dalam grup"
- On **re-delivery / second send**, participant is populated → works

**Evidence:** The error message shown matches `handleGroupImageMessage` line 826: `"Gagal mengidentifikasi pengirim. Silakan coba lagi atau tag @nomor Anda."`

### Target Fixes

| Priority | Fix | File(s) | Effort |
|----------|-----|---------|--------|
| P0 | **Add `imageMessage.contextInfo.participant` fallback** — Direct image messages carry sender in `contextInfo.participant` | `commandHandler.js:787-808` | 0.5h |
| P0 | **Add `videoMessage/documentMessage` fallbacks** — Same for other media types | `commandHandler.js:787-808` | 0.5h |
| P0 | **Store-based sender resolution** — If participant missing, look up message in store (has full key after Baileys processes) | `commandHandler.js:787-808` + `sessionManager.getSession()` | 1h |
| P1 | **Deferred retry on LID failure** — Requeue message processing once after 2-3s instead of immediate error | `whatsapp.js:156-245` (`handleMessageUpsert`) | 1h |
| P1 | **Normalize LID → phone** — If extracted lid is `@lid`, resolve via contacts or use `participantAlt` | `commandHandler.js:209-214` (`extractPhoneNumber`) | 0.5h |

### Recommended Fix Order

**Fix A (Immediate, 1h):** Extend LID extraction chain in `handleGroupImageMessage`:
```javascript
// Line ~791, after checking msg.key.participantAlt
else if (msg.message?.imageMessage?.contextInfo?.participant) {
    lid = extractPhoneNumber(msg.message.imageMessage.contextInfo.participant);
}
// Also for videoMessage, documentMessage, etc.
```

**Fix B (Robust, 1h):** Add store-based fallback:
```javascript
// If all participant fields missing, load from store (may have full key after processing)
const wa = sessionManager.getSession(sessionId);
if (wa?.store) {
    const stored = wa.store.loadMessages(msg.key.remoteJid, 1, { before: { id: msg.key.id, fromMe: false }});
    if (stored.length > 0 && stored[0].key?.participant) {
        lid = extractPhoneNumber(stored[0].key.participant);
    }
}
```

**Fix C (Architectural, 1h):** In `handleMessageUpsert`, catch LID failure and requeue once:
```javascript
// After handleGroupImageMessage returns/catches, if error === "Gagal mengidentifikasi pengirim"
// Re-add message to processing queue with 3s delay
```

---

## Combined Implementation Plan

### Week 1: Quick Wins (P0)

| Day | Task | Owner |
|-----|------|-------|
| 1 | Fix LID extraction fallbacks (Fix A) | You |
| 2 | Add store-based sender resolution (Fix B) | You |
| 3 | Test Case 2 fix in staging | You |
| 4-5 | Implement SQLite message store (Issue 1 P0) | You |

### Week 2: Harden & Polish

| Day | Task | Owner |
|-----|------|-------|
| 6 | Add date-range filter to `GET /messages` API | You |
| 7 | Store pruning job (daily cleanup > 90 days) | You |
| 8 | Docker volume optimization + healthcheck tuning | You |
| 9-10 | Load testing + production deploy | You |

---

## Acceptance Criteria

### Issue 1: Log Loading
- [ ] `GET /messages?jid=xxx&limit=50&from=2026-01-01&to=2026-08-06` returns in < 200ms (staging/load test pending)
- [ ] Memory usage stable < 300MB under load (10 concurrent requests)
- [x] Store size bounded by configurable auto-prune (default > 90 days)

### Issue 2: First Image Send
- [ ] Send image with caption "7h matematika algoritma dasar" → success on FIRST try (actual-device staging test pending)
- [ ] No "Gagal mengidentifikasi pengirim" error in logs (actual-device staging test pending)
- [ ] Works for: direct image, quoted image, image with @mention, video, document (actual-device staging test pending)

---

## Implementation Results (2026-08-06)

### Changes Applied

| Area | Change | Result |
|------|--------|--------|
| SQLite store | Added `store/sqlite-store.js` with indexed `loadMessages(jid, limit, cursor, options)` | Requests no longer require full-array sort/slice when SQLite is enabled |
| Session integration | `sessionManager.js` selects SQLite using `MESSAGE_STORE_TYPE=sqlite`; memory remains the default fallback | Rollback remains an environment-only change |
| Migration | Empty SQLite databases import existing `<session>_store.json` once and set `user_version=1` | Existing message history can move without a separate manual script |
| Retention | Added daily deletion of messages older than `MESSAGE_RETENTION_DAYS` | Store growth is bounded when SQLite is enabled |
| API | Added validated `from`/`to`, normalized unix sec/ms or ISO values, and capped `limit` to 1–500 | Date-filtered log requests are supported without breaking existing callers |
| Docker | Removed the `./:/app` and anonymous `node_modules` mounts; retained only `./sessions:/app/sessions` | Production image code is no longer shadowed by a Windows host bind mount |
| Sender resolution | Added media context fallbacks, awaited store lookup, `participantAlt`, self-message handling, and delayed bounded retry | First-upsert participant races no longer fail immediately |
| Baileys message lookup | Fixed async `loadMessages()` consumers in `sessionManager.js` and `whatsapp.js` to read the returned array | Retry/poll/update lookups now use the actual store contract |
| Tests | Added `node --test` suite in `test/sqlite-store.test.js` | Cursor/range, retention, and migration behavior are regression-covered |

### Verification Results

| Verification | Result |
|--------------|--------|
| `npm test` | ✅ PASS — 3 tests, 3 passed, 0 failed |
| `node --check` on all changed JavaScript files | ✅ PASS |
| Import smoke test: `commandHandler.js` | ✅ PASS |
| Import smoke test: `sessionManager.js` | ✅ PASS |
| `git diff --check` | ✅ PASS (line-ending conversion warnings only) |
| ESLint | ⚠️ Not runnable: repository uses `.eslintrc.json`, but installed ESLint 9 requires `eslint.config.*` |
| Docker Compose validation | ⚠️ Not runnable: Docker CLI is not installed in this environment |
| Actual WhatsApp device test | ⏳ Pending staging validation with Baileys v7 and a real group |
| `<200ms` / `<300MB` production targets | ⏳ Pending representative load test |

### Production Activation

1. Set `MESSAGE_STORE_TYPE=sqlite` in production `.env`.
2. Set `MESSAGE_RETENTION_DAYS=90` or the required retention window.
3. Rebuild the Docker image so code comes from the image rather than the removed repository bind mount.
4. Keep the existing JSON store during rollout; the first SQLite startup migrates it automatically and does not delete it.
5. Roll back by setting `MESSAGE_STORE_TYPE=memory` and restarting the service.

---

## Rollback Plan

| Change | Rollback |
|--------|----------|
| LID extraction fallbacks | Revert `commandHandler.js` to prior version |
| SQLite store | Set `MESSAGE_STORE_TYPE=memory` in `.env` |
| API date filter | No breaking change; optional params |

---

## Files to Modify

### Issue 1
- `store/sqlite-store.js` (NEW)
- `src/modules/sessionManager.js`
- `controllers/getMessages.js`
- `routes/chatsRoute.js`
- `docker-compose.yaml`
- `.env.example` (add `MESSAGE_STORE_TYPE`, `MESSAGE_RETENTION_DAYS`)

### Issue 2
- `src/modules/commandHandler.js` (lines 787-808, 209-214)
- `src/modules/sessionManager.js` (export `getSession` already)
- `whatsapp.js` (lines 156-245, for deferred retry option)

---

## Notes

- Baileys v7 (`7.0.0-rc.6`) has different `key.participant` behavior vs v6 — test on actual device
- Keep `memory-store.js` as fallback; don't delete
- The `journalQueue.js` already uses `better-sqlite3` — good precedent for SQLite usage
- Consider `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` for SQLite perf
