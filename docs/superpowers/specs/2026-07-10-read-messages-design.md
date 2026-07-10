# read_messages design: reading cached message history via the WhatsApp MCP server

**Date:** 2026-07-10
**Status:** Approved, pending implementation plan

## Problem

The MCP server can only send — there's no way for an agent to see what a
contact replied, or catch up on a conversation. This is also a prerequisite
for any future "agent reads and reacts to WhatsApp" work: an agent needs a
way to see messages before it can be taught to act on them.

## Goals

- Let an agent ask "what did X say" (`read_messages`) or "what's been
  happening" (`list_recent_chats`) for 1:1 chats.
- Cache messages locally, outside the repo, the same way contacts are cached
  today — so this data can never end up in a commit.
- Keep the two new tools as simple and self-contained as the existing three:
  no setup step, no config, reuse existing recipient-resolution exactly as-is.
- Be forthright about the privacy trade-offs of a feature that caches other
  people's message content, not just the user's own.

## Non-goals (v1)

- **Live/push delivery.** Still purely pull-based — an agent must be asked to
  check. There is no mechanism in this design for the MCP to wake up an agent
  when a message arrives; that gap was already identified as a separate,
  larger "scheduler/agent" problem, out of scope here.
- **Group chats.** 1:1 chats only. Groups need a per-participant sender field
  and group-name resolution that doesn't exist anywhere in this codebase yet.
- **Media download/extraction.** Incoming photos, videos, voice notes, and
  documents are represented as text placeholders only (e.g. `[image: nice
  pic!]`); no file is ever saved to disk for a received message.
- **Historical backfill.** Baileys only sees messages that arrive while the
  socket is connected. Caching starts the moment this feature ships; nothing
  before that is retrievable.
- **Read/unread receipt tracking.**
- **Encryption at rest.** The message cache gets the same protection as the
  existing auth session and contacts cache: OS file permissions only, no
  additional encryption layer.
- **Export/sync tooling.** Cached content never leaves the local machine
  except through a `read_messages`/`list_recent_chats` call itself.

## Design

### Storage — `~/.whatsapp-mcp/messages/`

One JSON file per 1:1 chat: `<jid>.json`, capped at the most recent 100
messages, trimmed oldest-first as new ones arrive. Chosen over a single
combined file (would rewrite all chats' history on every incoming message
anywhere) and over SQLite (a new dependency and schema to maintain for a
personal-scale cache that's realistically a few hundred messages per chat).

No separate index file for "recent chats" — `list_recent_chats` derives
directly from the per-chat files' newest entries, so there's only one piece
of persisted state to keep correct, not two that could drift apart.

Same trust tier as the existing `auth/` and `contacts.json`: lives outside
any git checkout, so it is structurally impossible to commit by accident.

### Message parsing — `src/messages.ts` (new, pure logic)

Following `contacts.ts`/`media.ts`'s convention — no I/O, independently
unit-testable:

- `type CachedMessage = { fromMe: boolean; timestamp: number; text: string }`
- `describeMessageContent(waMessage): string` — extracts plain text
  (`conversation` / `extendedTextMessage.text`), or a placeholder for media:
  `[image: caption]` / `[image]`, `[video: caption]` / `[video]`,
  `[voice note]`, `[document: filename]`, `[sticker]`, and
  `[unsupported message]` for anything else.
- `trimHistory(messages: CachedMessage[], max: number): CachedMessage[]` —
  keeps the newest `max` entries.
- `isTrackableChat(jid: string): boolean` — `true` for 1:1 phone/`@lid`
  JIDs, `false` for `@g.us` (groups), `status@broadcast`, and other
  `@broadcast` JIDs.

### Caching — `WhatsAppClient` (`src/whatsapp.ts`)

- Subscribes to Baileys' `messages.upsert` event, acting only on
  `type: "notify"` batches (live messages) — `"append"` batches are history
  sync and are ignored, which is what enforces the no-backfill non-goal at
  the source.
- Per message: skip if `!isTrackableChat(remoteJid)`. Otherwise canonicalize
  the chat JID through the same `lidToPn` map already maintained for
  contacts (so a chat file and its corresponding contact entry always agree
  on one identity), build a `CachedMessage` via `describeMessageContent`,
  and persist: read the chat's existing file (or start empty), append,
  `trimHistory(..., 100)`, write back.
- Two new read methods:
  - `getMessages(jid: string, limit: number): Promise<CachedMessage[]>` —
    reads one chat's file, returns the newest `limit` entries.
  - `listRecentChats(limit: number): Promise<{ jid: string; lastAt: number; preview: string }[]>` —
    lists the `messages/` directory, reads each file's newest entry, sorts
    by recency, returns the top `limit`.

### Tools — `src/server.ts`

**`read_messages(recipient: string, limit?: number)`**
- Recipient resolution is the exact `resolveRecipient` call `send_message`
  already uses — identical name/number/`me`/ambiguous/not-found handling.
- `limit` optional, default 20, capped at 100 (the storage cap).
- Returns a chronological transcript: `"You: <text>"` / `"<Name>: <text>"`
  per line, with timestamps.
- No cached history for that chat → `"No cached messages with <name> yet —
  only messages sent/received since this feature was enabled are
  available."`

**`list_recent_chats(limit?: number)`**
- No recipient needed. `limit` optional, default 20.
- For each recent chat file, resolves the JID to a contact name via the
  existing contacts cache (falls back to the phone number if unknown).
- Returns chats sorted newest-first: name, last-message time, short preview.
- No cached activity at all → `"No cached message activity yet."`

### Privacy & storage

- Storage location and git-invisibility as above.
- No message content is ever written to any log. The existing Baileys/pino
  logger stays silent by default, and no new diagnostic line introduced by
  this feature prints message text — only structural info (e.g. "failed to
  persist message for a chat") if something goes wrong.
- `read_messages` only ever returns one explicitly-named chat's history —
  there is no "dump every conversation" tool.
- **Caveat outside this MCP's control:** once an agent calls `read_messages`,
  that content necessarily enters the agent's own context and, depending on
  the host application, may be recorded in that host's own client-side logs
  (observed firsthand this session: Claude Code's local MCP debug logs record
  tool call results in plaintext). This is inherent to any MCP tool that
  returns message content to a caller, not something this design can fix at
  the server level — documented here so it's an informed trade-off, not a
  silent one.

### Error handling

| failure | handling |
|---|---|
| chat file missing/corrupt on read | treated as empty history (same tolerant pattern as `loadContactCache`) |
| write failure while caching an incoming message | caught and logged (no content, just that persistence failed); never crashes the live socket — caching is best-effort, sending/receiving must keep working regardless |
| `messages/` directory doesn't exist yet | `listRecentChats` treats this as zero chats, not an error |
| recipient not found / ambiguous / invalid in `read_messages` | unchanged existing `resolveRecipient` error paths, identical to `send_message` today |

### Testing

- `src/messages.test.ts` (new) — unit tests for `describeMessageContent`
  (text, image with/without caption, video with/without caption, voice
  note, document, sticker, unsupported type), `trimHistory` (under/at/over
  cap), and `isTrackableChat` (1:1 phone JID, `@lid` JID, group, status,
  broadcast).
- No new tests for the `whatsapp.ts` I/O wrapper methods themselves —
  consistent with how the existing contacts persistence layer is trusted
  today rather than unit-tested.
- Manual E2E steps added to `docs/design-plan.md`'s verification checklist:
  have a real contact send a text, an image with a caption, and a voice
  note; confirm `read_messages` renders all three correctly and in order;
  confirm `list_recent_chats` shows that chat with the right preview;
  restart the MCP server and confirm history survived the restart.

## Alternatives considered

- **Single combined `messages.json` for all chats.** Rejected — every
  incoming message anywhere would rewrite the entire file, and a corrupted
  write would risk every chat's history at once instead of just one chat's.
- **SQLite.** Rejected for v1 — a real embedded database is more scalable
  and query-capable, but adds a new dependency, a schema to maintain, and
  native-module install friction for a cache that's realistically a few
  hundred messages per chat at personal scale. Worth revisiting only if this
  ever needs to scale well beyond that.
- **Persisted index file for `list_recent_chats`.** Rejected in favor of
  deriving recency directly from the per-chat files — avoids a second piece
  of state that could drift out of sync with the source files.
- **Live/push notification mechanism.** Rejected for this design — it's a
  materially bigger problem (needs a trigger outside the MCP process
  entirely) that was already parked as a separate future topic.
- **Including group chats.** Rejected for v1 — would require a
  per-participant sender field and group-name resolution that doesn't exist
  anywhere in the codebase yet; deferred rather than designed half-way.
