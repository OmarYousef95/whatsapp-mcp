# Learning MCP with this repo

This project was built partly to answer: *what actually IS an MCP server, and what does it take to build one?* Here's the mental model, using this repo as the running example.

## The three roles

```
┌─────────────────────────────┐        ┌──────────────────┐
│  HOST  (Claude Code/Desktop)│        │  SERVER (this!)  │
│  ┌───────────────────────┐  │ stdio  │                  │
│  │ CLIENT (built-in)     │◄─┼────────┼─► tools:         │
│  │ speaks JSON-RPC 2.0   │  │        │   send_message   │
│  └───────────────────────┘  │        │   search_contacts│
└─────────────────────────────┘        └──────────────────┘
```

- **Host** — the app the user talks to (Claude Code, Claude Desktop, …). It decides *when* to call tools, based on the conversation.
- **Client** — the protocol plumbing inside the host. One client per server connection.
- **Server** — a small external program (this repo) that exposes capabilities.

If you come from Kotlin/KMP: a server is like a module exposing a typed service interface — but the interface contract (tool schemas) is discovered **at runtime**, not compiled against. The host calls `tools/list` to learn what you offer, then `tools/call` to invoke.

## The transport: why stdio?

The host spawns your server as a child process and pipes JSON-RPC messages through **stdin/stdout**. No ports, no HTTP, no auth handshake — process ownership *is* the trust boundary. That's perfect for local, personal tools like this one.

You can watch it happen with nothing but a shell:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"me","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

The lifecycle: `initialize` (capability negotiation) → `initialized` (ready) → then any number of `tools/list` / `tools/call`.

**The classic footgun:** because stdout carries the protocol, a single stray `console.log` corrupts a JSON-RPC frame and the client drops the connection with a cryptic parse error. All logging goes to **stderr** (see the pino setup in `src/whatsapp.ts`).

## Tools are prompts

The part nobody tells you: your tool **names, descriptions, and schema `.describe()` strings are read by the LLM**. They're not documentation for humans — they're the model's only instructions for using your server correctly.

Compare, from `src/server.ts`:

```
"`recipient` accepts: a contact name (must match EXACTLY one saved contact ...
 if zero or several match, the call fails and lists the candidates so you can
 ask the user which one they meant) ..."
```

That sentence *is* the safety system, as much as the code is. It tells the model what failure looks like and what to do about it (ask the user — not retry blindly).

Design rules that worked here:

1. **One zod schema, three jobs** — the SDK converts your zod shape to JSON Schema (advertised to the client), validates incoming args against it, and infers your handler's TypeScript types from it. Single source of truth.
2. **Errors are content, not exceptions** — return `{ content: [...], isError: true }` with a message written *for the model*: state what went wrong and what a correct next step is. A thrown exception becomes a generic error; a crafted `isError` result becomes model-recoverable.
3. **Refuse ambiguity** — this server's whole personality. A messaging tool that guesses recipients is a liability; one that refuses and explains is trustworthy.

## Code map

| File | Layer | Read it to learn |
|---|---|---|
| `src/server.ts` | MCP | Tool registration, schemas, error philosophy — **start here** |
| `src/index.ts` | entry | CLI-command vs MCP-server routing in one binary |
| `src/contacts.ts` | domain | Pure, unit-tested resolution logic kept free of I/O |
| `src/contacts.test.ts` | tests | The safety cases, including the real-world one that motivated them |
| `src/whatsapp.ts` | integration | Session persistence, reconnect handling, stderr-only logging |
| `src/login.ts` | CLI | The one-time QR pairing flow |

Architecture takeaway: the MCP surface (~150 lines) and the WhatsApp plumbing are strictly separated. You could swap Baileys for anything else without touching a line of protocol code — and the protocol layer stays small enough to read in one sitting.

## Beyond tools

MCP servers can also expose **resources** (data the host can read into context — think "files"), **prompts** (reusable templates the user invokes), and more. This server needs none of them, which is itself a lesson: most useful servers are just 1–3 well-described tools.

## Further reading

- Protocol + concepts: https://modelcontextprotocol.io
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Debugging tool: `npx @modelcontextprotocol/inspector node dist/index.js`
