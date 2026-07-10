# whatsapp-mcp

An [MCP](https://modelcontextprotocol.io) server for **personal** WhatsApp accounts. Lets Claude (or any MCP client) send WhatsApp messages on your behalf — no browser automation, no Business API, no Meta approval process. Pairs with your phone exactly like WhatsApp Web does: scan one QR, done.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks WhatsApp's WebSocket protocol directly.

> Learning MCP? This repo doubles as a small, heavily-commented example server — see [LEARNING.md](LEARNING.md) and start reading at `src/server.ts`.

## Tools

| Tool | What it does |
|---|---|
| `send_message` | Send a text message, a local file (image/video/document, optionally with a caption), or both to a contact name, a phone number, or `me` (your self-chat) |
| `search_contacts` | Find contacts by name fragment, returns names + numbers |
| `get_connection_status` | Connection/pairing state, contact-sync count — for diagnosing before sending |

**Safety by design** — born from a real incident where an automation picked the wrong "Omar":

- A contact name must match **exactly one** saved contact (case-insensitive). Zero or several matches → the tool refuses and lists candidates instead of guessing.
- Raw phone numbers are verified to exist on WhatsApp before anything is sent.
- Every send confirms back exactly who received the message (name + number).

## Setup

Requires Node.js ≥ 20.

```bash
git clone https://github.com/OmarYousef95/whatsapp-mcp.git
cd whatsapp-mcp
npm install && npm run build

# one-time pairing: prints a QR in your terminal
node dist/index.js login

# QR won't scan (some terminal fonts distort it)? Use a typed pairing code instead:
node dist/index.js login +962791234567   # your own number, international format
```

Scan the QR with your phone (**WhatsApp → Settings → Linked Devices → Link a Device**). The session persists in `~/.whatsapp-mcp/` — you won't need to scan again unless you unlink the device.

> No terminal handy? If you skip `login` and just call a tool from Claude, the error response includes the QR so you can scan it straight from the chat.

### Add to Claude Code

```bash
claude mcp add whatsapp -- node /path/to/whatsapp-mcp/dist/index.js
```

### Add to Claude Desktop

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/whatsapp-mcp/dist/index.js"]
    }
  }
}
```

Then just ask: *"send a WhatsApp to +962791234567 saying I'm running late"* or *"message me a reminder to buy milk"*.

## Where your data lives

| Path | Contents |
|---|---|
| `~/.whatsapp-mcp/auth/` | Your paired session keys (treat like a password — anyone with this folder can act as your WhatsApp) |
| `~/.whatsapp-mcp/contacts.json` | Local contact-name cache used for name → number resolution |

Everything stays on your machine. Nothing is sent anywhere except to WhatsApp itself. To revoke access: delete `~/.whatsapp-mcp/auth/` or remove the linked device from your phone.

## Honest caveats

- **Unofficial API.** Baileys reimplements the WhatsApp Web protocol and is not endorsed by Meta. Using it technically violates WhatsApp's Terms of Service, and there is a small but real risk of account suspension. Use a personal tool responsibly: low volume, real conversations, **never spam**. If that risk worries you, pair a secondary number for testing first.
- Contact names come from WhatsApp's sync and may take a moment to populate after first pairing. Phone numbers always work.
- Baileys tracks a moving target; if WhatsApp changes the protocol, update the pinned dependency.

## Development

```bash
npm test        # unit tests (contact resolution — the safety-critical bit)
npm run dev     # run the server from source
npm run login   # pairing flow from source
```

## Roadmap

- npm publish for true `npx whatsapp-mcp` one-liner install

MIT © Omar Yousef
