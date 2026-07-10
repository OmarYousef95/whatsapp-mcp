# send_media design: sending files via the WhatsApp MCP server

**Date:** 2026-07-10
**Status:** Approved, pending implementation plan

## Problem

The `send_message` MCP tool can only send plain text. Users want to send a local
file — a photo, a video, a document — to a WhatsApp contact, number, or
themselves, the same way they can already send text.

## Goals

- Send images, videos, and documents from a local file path to a resolved
  WhatsApp recipient.
- Keep the interface simple: one tool, not one per media type, and no new
  parameter the caller has to get right beyond an optional file path.
- Reuse all existing recipient-resolution behavior (`resolveRecipient`) exactly
  as-is — media sends must behave identically to text sends for name/number/
  `me`/ambiguous/not-found handling.

## Non-goals (v1)

- Audio/voice notes and stickers — Baileys supports them, but they're out of
  scope for this iteration; can be added later behind the same design.
- Remote URLs as a media source — only local file paths on the machine running
  the MCP server.
- Client-side file size validation against WhatsApp's limits — send is
  attempted regardless of size; any failure (including oversized files) is
  surfaced via the normal error path rather than pre-checked.

## Design

### Tool schema

`send_message` is extended in place (not a new tool):

```
send_message(recipient: string, message?: string, file_path?: string)
```

There is a single text field, `message`, used for both cases:

| message | file_path | behavior |
|---|---|---|
| set | absent | plain text message (today's existing behavior, unchanged) |
| absent | set | file sent with no caption |
| set | set | file sent, `message` becomes its caption |
| absent | absent | rejected before any resolution/network work: `"Provide a message, a file_path, or both."` |

No separate `caption` parameter — reusing `message` keeps the schema to one
text field regardless of whether the call is text-only, file-only, or both.

### Media type detection — `src/media.ts` (new, pure logic)

A new module, following `contacts.ts`'s existing convention of pure,
no-I/O, independently unit-testable functions:

- `mediaKindForPath(filePath: string): "image" | "video" | "document"` —
  extension-based, case-insensitive. Recognized image extensions
  (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) → `"image"`; recognized video
  extensions (`.mp4`, `.mov`, `.3gp`, `.avi`, `.mkv`) → `"video"`; anything
  else (unknown or missing extension) → `"document"`. Unrecognized types
  falling back to `"document"` matches WhatsApp's own model — `document` is
  a generic file container that accepts any file type.
- `mimeTypeForPath(filePath: string): string` — small extension → MIME map
  covering common types; falls back to `application/octet-stream`. Only
  needed for the `document` case, where Baileys' `AnyMediaMessageContent`
  type requires a `mimetype` field.

### Sending — `WhatsAppClient.sendMedia` (`src/whatsapp.ts`, new method
alongside the existing `sendText`)

```
async sendMedia(jid: string, filePath: string, caption?: string): Promise<void>
```

- Not connected → throws, same guard as `sendText`.
- Picks `mediaKindForPath(filePath)` and calls `sock.sendMessage` with the
  matching Baileys media field:
  - `image` → `{ image: { url: filePath }, caption }`
  - `video` → `{ video: { url: filePath }, caption }`
  - `document` → `{ document: { url: filePath }, mimetype: mimeTypeForPath(filePath), fileName: basename(filePath), caption }`
- Baileys reads local files itself from `{ url: filePath }` (confirmed via
  its `messages-media.js` implementation — it distinguishes local paths from
  http(s) URLs and uses `createReadStream` for the former). No manual file
  buffering is needed in this codebase.

### Tool handler (`src/server.ts`)

- Validate `message`/`file_path` presence (at least one required) before
  calling `resolveRecipient` — fail fast, no wasted resolution work.
- Recipient resolution: identical to today's `send_message` — same
  `switch (resolution.kind)` over `invalid` / `not_found` / `ambiguous` /
  `self` / `number` / `resolved`.
- Once a `jid` is resolved:
  - `file_path` present → `client.sendMedia(jid, file_path, message)` inside
    a try/catch. Any thrown error (file not found, oversized, corrupt,
    Baileys/network failure) is caught and returned as
    `err("Failed to send file: " + e.message)` — one uniform error path for
    every media failure mode, no separate pre-flight checks.
  - `file_path` absent → `client.sendText(jid, message!)`, unchanged from
    today (message is guaranteed present by the earlier validation).
- Success confirmation echoes what was sent: recipient + filename (+ caption
  if present) for media, recipient + text for plain messages — mirrors the
  existing "always confirm exactly who/what was sent" pattern.
- Tool description updated to document the new `file_path` param, that media
  type is auto-detected from the extension, and that `message` doubles as
  the caption when both are given. Same "confirm with the user before
  sending unless they explicitly dictated both recipient and content"
  guidance applies to media sends too.

### Error handling summary

| failure | where caught | message |
|---|---|---|
| neither message nor file_path | server.ts, before resolution | `"Provide a message, a file_path, or both."` |
| recipient not found / ambiguous / invalid | server.ts (unchanged existing logic) | unchanged existing messages |
| number not registered on WhatsApp | server.ts (unchanged existing `numberExists` check) | unchanged existing message |
| file doesn't exist, too large, corrupt, or any Baileys send failure | server.ts, try/catch around `sendMedia` | `"Failed to send file: " + e.message` |

### Testing

- `src/media.test.ts` (new) — unit tests for `mediaKindForPath` and
  `mimeTypeForPath`: case-insensitivity, no extension, path with directory
  components, unknown extension → `document`, following the existing
  fictional-data convention used in `contacts.test.ts`.
- Manual E2E step added to `docs/design-plan.md`'s verification checklist:
  send an image, a video, and a document to `"me"`, confirm receipt on
  phone, confirm a text-only send and a message+file+caption send both still
  behave correctly.

## Alternatives considered

- **Standalone `send_media` tool, separate from `send_message`.** Rejected —
  the user wants the interaction to feel like one "send" action regardless of
  whether it's text or a file; unifying into one tool matches that model.
  (The split would have been invisible to the end user either way, since tool
  selection happens at the LLM layer, not the human layer — but a single
  tool is simpler for the model to reason about too: one call handles every
  case instead of picking between two similar tools.)
- **One tool per media type** (`send_image`, `send_video`, `send_document`).
  Rejected — three near-duplicate tool definitions for marginal clarity gain,
  and reopens the "what if the file doesn't match the tool the caller picked"
  mismatch problem that auto-detection avoids.
- **Separate `caption` parameter alongside `message`.** Rejected in favor of
  reusing `message` as the caption — avoids a redundant second text field.
- **Client-side file size validation before sending.** Explicitly rejected by
  the user — errors (including oversized files) are surfaced via the normal
  send failure path rather than pre-checked against WhatsApp's limits.
