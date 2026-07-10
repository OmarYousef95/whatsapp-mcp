# WhatsApp MCP Server — Brainstorm Notes

## Idea
Build an MCP (Model Context Protocol) server that lets Claude interact with a **personal** WhatsApp account (not WhatsApp Business API) — e.g. "send this file to Mahmoud on WhatsApp" as a natural-language command to Claude.

## Why this is a good learning project
- Covers the full MCP lifecycle: tool definitions, input schemas, structured results, error handling — not a toy "hello world" example.
- It's **stateful** (session persistence, reconnects) — a step up from simple API-wrapper MCP servers.
- Genuinely useful, so you'll dogfood it and catch real rough edges.
- Maps to your existing FE/BE contract-design experience (Kotlin/Strapi) — an MCP server is the same kind of "clean interface between two systems" problem.

## Distribution model
- Push code to a public GitHub repo (optionally publish to npm for `npx` install).
- Each user runs their **own instance** and links their **own** WhatsApp account (own QR scan, own session).
- You are not operating a shared/multi-user server — important both technically (sessions are per-device) and for trust/legal reasons.
- README should be upfront that this relies on an **unofficial** protocol library and carries some ban risk — consider recommending a secondary number for testing.

## Library choice: Baileys vs whatsapp-web.js

| | Baileys | whatsapp-web.js |
|---|---|---|
| How it works | Direct websocket connection to WhatsApp's protocol (reverse-engineered) | Puppeteers a real Chrome instance loading web.whatsapp.com |
| Resource footprint | Light — no browser | Heavy — full Chromium instance |
| Setup friction for others | Low (just `npm install`, scan QR) | Higher (needs working Puppeteer/Chromium) |
| Resilience | More resilient to WhatsApp UI/DOM changes; more exposed to protocol-level changes | More resilient to protocol changes; fragile to DOM/selector changes |
| Community/tutorials | Smaller, more low-level API | Larger, more beginner-friendly, more stars |

**Decision leaning: Baileys** — better fit since this is a repo other people will clone and run themselves; avoiding a Chromium dependency lowers setup friction significantly.

## Proposed folder structure
```
whatsapp-mcp-server/
├── src/
│   ├── index.ts          # MCP server entrypoint, registers tools
│   ├── whatsapp/
│   │   ├── client.ts     # Baileys connection, QR auth, session mgmt
│   │   └── contacts.ts   # contact lookup/search helpers
│   ├── tools/
│   │   ├── sendMessage.ts
│   │   ├── sendFile.ts
│   │   └── findContact.ts
│   └── types.ts
├── auth_session/         # persisted Baileys session (gitignored!)
├── package.json
└── README.md
```

## Proposed tools

1. **`find_contact`**
   - Input: `{ query: string }` (name or phone fragment)
   - Output: list of matches `{ name, jid, phone }`
   - Needed first so Claude can resolve a name to an actual WhatsApp ID.

2. **`send_message`**
   - Input: `{ jid: string, text: string }`
   - Output: `{ success: bool, messageId }`

3. **`send_file`**
   - Input: `{ jid: string, filePath or fileUrl: string, caption?: string }`
   - Output: `{ success: bool, messageId }`

4. **`get_connection_status`**
   - Output: `{ connected: bool, needsQrScan: bool }`
   - Lets Claude tell the user "you need to scan a QR code" instead of failing silently.

## Lifecycle to design around
- **First run:** no session exists → server generates QR → user scans once → session saved to disk.
- **Subsequent runs:** session reloads automatically, no QR needed.
- **Forced re-auth:** WhatsApp unlinks the device occasionally → server must detect and surface this clearly, not just throw a raw error.

## Open design question
Should `send_message` / `send_file` require explicit user confirmation before actually sending, since these are real-world side effects (not read-only)? Likely yes — tool descriptions should nudge Claude to confirm with the user before firing off a message, similar to how send/modify actions elsewhere require confirmation.

## Suggested build order (when ready to start)
1. Get Baileys working standalone first — send a message via a plain script, no MCP yet.
2. Wrap one tool (`send_message`) in a minimal MCP server, test in Claude Desktop.
3. Add more tools incrementally (file sending, contact search).
4. Handle the hard parts: reconnects, QR re-auth, surfacing errors back to Claude cleanly.
