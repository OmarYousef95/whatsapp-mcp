# whatsapp-mcp — Personal WhatsApp MCP Server (v1)

## Context

Today's WhatsApp automation journey went: AppleScript UI-scripting (fragile, mis-focused windows) → Puppeteer/CDP script against WhatsApp Web (worked, but browser-DOM selectors broke twice and one synthetic-click bug caused a real wrong-recipient send). Omar wants to go bigger: a proper, public, reusable **MCP server** for *personal* WhatsApp accounts (not Business API) — and to learn what MCP is and how to build one along the way.

**Decisions made during brainstorming (locked):**
| Decision | Choice |
|---|---|
| Repo | `whatsapp-mcp`, public GitHub, GitHub-first (npm publish later, once stable) |
| Language | TypeScript |
| Engine | **Baileys** (`@whiskeysockets/baileys`) — speaks WhatsApp's WebSocket protocol directly, **no browser at all**. Chosen because the audience is "anyone: easy public install" (whatsapp-web.js would drag a ~300MB Chromium download) and because every failure today came from browser automation |
| V1 tools | `send_message` + read-only `search_contacts` |
| Pairing UX | Both: `login` CLI command (QR in terminal) + in-chat fallback (unpaired tool calls return instructions/QR) |
| Recipient | Contact name (case-insensitive **exact** match, refuse + list candidates on 0 or >1 matches) or phone number; `"me"` aliases for self-chat |

**Safety lessons from today baked into the design:** never send on ambiguous recipient; always return the resolved recipient (name + number) in the tool result; verify raw numbers exist on WhatsApp (`onWhatsApp`) before sending.

## Architecture

```
~/whatsapp-mcp/
├── src/
│   ├── index.ts       # entry + bin: `whatsapp-mcp login` → login flow; no args → MCP server
│   ├── server.ts      # MCP layer: McpServer + StdioServerTransport, registers the 2 tools (zod schemas)
│   ├── whatsapp.ts    # Baileys wrapper: connect/reconnect, auth state, send, onWhatsApp check
│   ├── contacts.ts    # PURE contact-resolution logic (exact match / candidates) — unit-tested
│   └── login.ts       # CLI pairing: renders QR via qrcode-terminal, waits for success, exits
├── src/contacts.test.ts  # vitest tests for resolution logic (TDD)
├── package.json       # bin: whatsapp-mcp; deps below
├── tsconfig.json
├── README.md          # install, pairing, Claude Code/Desktop config, ToS disclaimer
├── LEARNING.md        # the "learn MCP" artifact — see Learning section
├── LICENSE            # MIT
└── .gitignore         # dist/, node_modules/ (auth lives OUTSIDE the repo — see below)
```

**Deps:** `@whiskeysockets/baileys`, `@modelcontextprotocol/sdk`, `zod`, `qrcode-terminal`, `pino`. Dev: `typescript`, `tsx`, `vitest`.

**Session & data live outside the repo** at `~/.whatsapp-mcp/`:
- `auth/` — Baileys `useMultiFileAuthState` credentials (the paired session). Never inside the repo dir → zero risk of committing secrets to the public repo.
- `contacts.json` — local contact cache, updated from Baileys `contacts.upsert`/`contacts.update` sync events (Baileys has no simple `getContacts()`; contacts arrive via sync events, so we persist them ourselves).

**Key flows:**
- **MCP mode (default):** eager Baileys connect at server start (~1–2 s), auto-reconnect on drop (`DisconnectReason` handling: reconnect unless `loggedOut`). Tools respond fast because the socket is already up.
- **`send_message(recipient, message)`:** resolve recipient → if name: exact match against contact cache (0 matches → error listing closest fuzzy candidates; >1 → error listing all matches with numbers; 1 → proceed). If number: normalize to E.164 digits, verify via `onWhatsApp`, send to `<digits>@s.whatsapp.net`. `"me"/"myself"/"self"` → own JID. Result always echoes the resolved name+number.
- **`search_contacts(query)`:** substring/fuzzy search over the contact cache; returns name + number list. Lets Claude resolve a contact by name before sending.
- **Unpaired state:** tools return a clear `login_required` error: "run `npx whatsapp-mcp login`" + the current ASCII QR when one is live (with a note it refreshes ~20 s).
- **MCP stdio gotcha (teach this):** stdout is reserved for JSON-RPC — ALL logging (including Baileys' pino logger) goes to stderr, or the protocol corrupts.

## Implementation steps

1. **Scaffold** — `mkdir ~/whatsapp-mcp`, `git init`, npm init, tsconfig (NodeNext, strict), deps, `.gitignore`, MIT LICENSE.
2. **Pin current APIs** — check Baileys + MCP TypeScript SDK current docs via context7 before writing code (both libraries have had breaking renames; e.g. `printQRInTerminal` was removed — QR now comes from the `connection.update` event).
3. **`contacts.ts` via TDD** — write vitest tests first for: exact single match, case-insensitivity, zero-match → candidates, multi-match → refusal list, number normalization, self aliases. Then implement (pure functions, no I/O).
4. **`whatsapp.ts`** — auth state at `~/.whatsapp-mcp/auth`, socket creation, reconnect loop, contact-sync → `contacts.json` persistence, `sendText(jid, text)`, `checkNumber(number)`.
5. **`login.ts`** — connection with QR rendered by qrcode-terminal, success message ("Paired as +962…"), clean exit. Handle already-paired case.
6. **`server.ts`** — `McpServer`, `StdioServerTransport`, register `send_message` + `search_contacts` with zod schemas and rich descriptions (tool descriptions are the "prompt" the LLM sees — write them carefully), login-required error path.
7. **`index.ts`** — shebang + arg routing (`login` | default server), `bin` entry in package.json.
8. **Docs** — README (what it is, install, pair, `claude mcp add whatsapp -- npx -y whatsapp-mcp`, Claude Desktop JSON config, security notes, unofficial-API/ToS disclaimer, "no spam" note) + LEARNING.md.
9. **Verify end-to-end** (below), fix what breaks.
10. **Publish** — `gh repo create whatsapp-mcp --public`, push. npm publish deferred until it's proven stable.

## Learning component (explicit goal: learn MCP)

- **LEARNING.md**: what MCP is (host ↔ client ↔ server, JSON-RPC over stdio, tools vs resources vs prompts), a walkthrough of this repo's code, and the classic pitfalls (stdout corruption, tool-description quality, schema design). KMP analogy for Omar: an MCP server is like exposing a typed service interface that the host app discovers at runtime — tool schemas ≈ the interface contract, stdio transport ≈ the IPC channel.
- Code stays small and heavily commented at the MCP boundary (`server.ts`, `index.ts`) — those two files ARE the tutorial; the WhatsApp plumbing is kept separate so the MCP concepts aren't buried.
- Build steps 6–7 are done deliberately with explanation, not rushed.

## Verification

1. **Unit:** `npx vitest run` — contact resolution suite green.
2. **Protocol-level:** `npx @modelcontextprotocol/inspector node dist/index.js` — confirm both tools list correctly, schemas render, calling `send_message` unpaired returns the login instructions.
3. **Pairing:** `node dist/index.js login` → scan QR with phone → paired session persists at `~/.whatsapp-mcp/auth`; second run says already-paired.
4. **Real E2E in Claude Code:** `claude mcp add whatsapp -- node ~/whatsapp-mcp/dist/index.js`, restart, then: send to `"me"` → verify on phone; `search_contacts("<a saved contact name>")` → correct match; send to ambiguous name (e.g. a name shared by two contacts) → confirm it REFUSES and lists candidates (regression test for today's incident); send to a raw phone number → delivered; send an image, a video, and a document (each with and without a caption) to `"me"` → confirm all three arrive with the correct type (images/video render inline, not as a generic file icon) and that captions show up when given; have a real contact send a text message, an image with a caption, and a voice note → call `read_messages(<that contact>)` and confirm all three appear correctly, oldest-first, labeled with the right sender; call `list_recent_chats()` and confirm that chat appears with an accurate preview; restart the MCP server and re-run both → confirm the cached history survived the restart.
5. **Secret hygiene before push:** confirm `~/.whatsapp-mcp` is outside the repo and `git status` shows no auth files; run secret scan on the repo before making it public.

## Risks / honest caveats (documented in README)

- Baileys is an **unofficial** protocol implementation — against WhatsApp ToS; small but real account-ban risk. Personal use, low volume, no spam. Same risk class as the WhatsApp Web session Omar already uses.
- Contact cache depends on WhatsApp's history sync — some contacts may not appear until first sync completes; phone numbers always work as fallback.
- Baileys has breaking API drift between versions — pin the version in package.json.
