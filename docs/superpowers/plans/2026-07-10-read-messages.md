# read_messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only MCP tools — `read_messages` and `list_recent_chats` — backed by a local, per-chat message cache, so an agent can see what a contact said instead of only being able to send.

**Architecture:** A new pure module `src/messages.ts` (message-content parsing, cache trimming, chat-trackability rules — no I/O, unit-tested) is consumed by `WhatsAppClient` (`src/whatsapp.ts`), which subscribes to Baileys' `messages.upsert` event and persists one JSON file per 1:1 chat under `~/.whatsapp-mcp/messages/`. Two new tools in `src/server.ts` read that cache via `resolveRecipient`, the exact same recipient-resolution logic `send_message` already uses.

**Tech Stack:** TypeScript (NodeNext), `@whiskeysockets/baileys`, `zod`, `vitest`. No new dependencies.

## Global Constraints

- Storage: `~/.whatsapp-mcp/messages/`, one JSON file per chat (`<jid>.json`), outside any git checkout.
- Cap: 100 messages per chat, oldest trimmed first.
- Default `limit` for both new tools: 20. Max: 100.
- Only `messages.upsert` events with `type: "notify"` are cached — `"append"` (history sync) batches are ignored. No historical backfill.
- 1:1 chats only — `@s.whatsapp.net` and `@lid` JIDs. Groups (`@g.us`), `status@broadcast`, and other `@broadcast` JIDs are never cached.
- Media (images, video, voice notes, documents, stickers) is represented as a text placeholder only — no file is ever downloaded or saved for a received message.
- No message content is ever written to a log — only structural failures (e.g. "failed to persist a cached message") may be logged.
- `read_messages`/`list_recent_chats` reuse the exact `resolveRecipient` call and `switch (resolution.kind)` handling that `send_message` already uses in `src/server.ts` — same name/number/`me`/ambiguous/not-found behavior.

---

### Task 1: Message parsing and cache-trimming logic — `src/messages.ts`

**Files:**
- Create: `src/messages.ts`
- Test: `src/messages.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no dependencies on other project files).
- Produces (consumed by Task 2):
  - `interface CachedMessage { fromMe: boolean; timestamp: number; text: string }`
  - `interface MessageContentLike { conversation?: string | null; extendedTextMessage?: { text?: string | null } | null; imageMessage?: { caption?: string | null } | null; videoMessage?: { caption?: string | null } | null; audioMessage?: object | null; documentMessage?: { fileName?: string | null } | null; stickerMessage?: object | null }`
  - `describeMessageContent(content: MessageContentLike | null | undefined): string`
  - `trimHistory(messages: CachedMessage[], max: number): CachedMessage[]`
  - `isTrackableChat(jid: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/messages.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { describeMessageContent, isTrackableChat, trimHistory, type CachedMessage } from "./messages.js";

describe("describeMessageContent", () => {
  it("returns plain conversation text", () => {
    expect(describeMessageContent({ conversation: "hey there" })).toBe("hey there");
  });

  it("returns extended text message text", () => {
    expect(describeMessageContent({ extendedTextMessage: { text: "replying to a quote" } })).toBe(
      "replying to a quote"
    );
  });

  it("describes an image with a caption", () => {
    expect(describeMessageContent({ imageMessage: { caption: "nice pic!" } })).toBe("[image: nice pic!]");
  });

  it("describes an image with no caption", () => {
    expect(describeMessageContent({ imageMessage: {} })).toBe("[image]");
  });

  it("describes a video with a caption", () => {
    expect(describeMessageContent({ videoMessage: { caption: "watch this" } })).toBe("[video: watch this]");
  });

  it("describes a video with no caption", () => {
    expect(describeMessageContent({ videoMessage: {} })).toBe("[video]");
  });

  it("describes a voice note", () => {
    expect(describeMessageContent({ audioMessage: { ptt: true } })).toBe("[voice note]");
  });

  it("describes a document with a filename", () => {
    expect(describeMessageContent({ documentMessage: { fileName: "invoice.pdf" } })).toBe(
      "[document: invoice.pdf]"
    );
  });

  it("describes a document with no filename", () => {
    expect(describeMessageContent({ documentMessage: {} })).toBe("[document]");
  });

  it("describes a sticker", () => {
    expect(describeMessageContent({ stickerMessage: {} })).toBe("[sticker]");
  });

  it("falls back to unsupported for a message shape with no known fields", () => {
    expect(describeMessageContent({})).toBe("[unsupported message]");
  });

  it("falls back to unsupported for null content", () => {
    expect(describeMessageContent(null)).toBe("[unsupported message]");
  });

  it("falls back to unsupported for undefined content", () => {
    expect(describeMessageContent(undefined)).toBe("[unsupported message]");
  });
});

describe("trimHistory", () => {
  const makeMessages = (count: number): CachedMessage[] =>
    Array.from({ length: count }, (_, i) => ({ fromMe: false, timestamp: i, text: `msg ${i}` }));

  it("keeps everything when under the cap", () => {
    const messages = makeMessages(3);
    expect(trimHistory(messages, 5)).toEqual(messages);
  });

  it("keeps everything when exactly at the cap", () => {
    const messages = makeMessages(5);
    expect(trimHistory(messages, 5)).toEqual(messages);
  });

  it("drops the oldest entries when over the cap", () => {
    const messages = makeMessages(7);
    const result = trimHistory(messages, 5);
    expect(result).toHaveLength(5);
    expect(result[0].text).toBe("msg 2");
    expect(result[4].text).toBe("msg 6");
  });
});

describe("isTrackableChat", () => {
  it("accepts a 1:1 phone JID", () => {
    expect(isTrackableChat("15555550123@s.whatsapp.net")).toBe(true);
  });

  it("accepts a 1:1 lid JID", () => {
    expect(isTrackableChat("987654321@lid")).toBe(true);
  });

  it("rejects a group JID", () => {
    expect(isTrackableChat("123456-789@g.us")).toBe(false);
  });

  it("rejects the status broadcast JID", () => {
    expect(isTrackableChat("status@broadcast")).toBe(false);
  });

  it("rejects other broadcast JIDs", () => {
    expect(isTrackableChat("123456@broadcast")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/messages.test.ts`
Expected: FAIL — `Cannot find module './messages.js'` (the module doesn't exist yet).

- [ ] **Step 3: Implement `src/messages.ts`**

```typescript
// Pure message-content parsing and cache-trimming logic. No I/O — matches
// contacts.ts's and media.ts's convention of keeping decision logic in
// small, fully unit-tested, dependency-free functions.
//
// This cache holds other people's message content, not just the user's own
// — see the "Privacy & storage" section of the read_messages design doc
// (docs/superpowers/specs/2026-07-10-read-messages-design.md) for what that
// does and doesn't mean for how this data is handled.

export interface CachedMessage {
  fromMe: boolean;
  /** Milliseconds since epoch. */
  timestamp: number;
  text: string;
}

/**
 * The minimal shape of a Baileys `WAMessage["message"]` we read from. Kept
 * narrow and structural (rather than importing Baileys' own proto types) so
 * this module stays dependency-free and its tests can build plain object
 * fixtures instead of full protobuf-shaped messages.
 */
export interface MessageContentLike {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  audioMessage?: object | null;
  documentMessage?: { fileName?: string | null } | null;
  stickerMessage?: object | null;
}

/**
 * Plain text for a text message, or a placeholder for media/unsupported
 * types. Never downloads or inspects file content — see the "no media
 * download" non-goal in the design doc.
 */
export function describeMessageContent(content: MessageContentLike | null | undefined): string {
  if (!content) return "[unsupported message]";
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage) {
    return content.imageMessage.caption ? `[image: ${content.imageMessage.caption}]` : "[image]";
  }
  if (content.videoMessage) {
    return content.videoMessage.caption ? `[video: ${content.videoMessage.caption}]` : "[video]";
  }
  if (content.audioMessage) return "[voice note]";
  if (content.documentMessage) {
    return content.documentMessage.fileName
      ? `[document: ${content.documentMessage.fileName}]`
      : "[document]";
  }
  if (content.stickerMessage) return "[sticker]";
  return "[unsupported message]";
}

/** Keeps only the newest `max` entries, assuming oldest-first ordering. */
export function trimHistory(messages: CachedMessage[], max: number): CachedMessage[] {
  return messages.length <= max ? messages : messages.slice(messages.length - max);
}

/**
 * True for a trackable 1:1 chat (phone or privacy "LID" JID). False for
 * groups, status updates, and broadcasts — see the "group chats" non-goal.
 */
export function isTrackableChat(jid: string): boolean {
  if (!jid) return false;
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast")) return false;
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/messages.test.ts`
Expected: PASS — all 19 tests green.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS — 66 tests total (47 existing + 19 new), pristine output.

- [ ] **Step 6: Commit**

```bash
git add src/messages.ts src/messages.test.ts
git commit -m "$(cat <<'EOF'
Add pure message-content parsing and cache-trimming logic

Foundation for read_messages/list_recent_chats: extracts plain text or a
placeholder from a Baileys message, trims per-chat history to a cap, and
decides which chats are trackable (1:1 only, no groups/broadcasts).
EOF
)"
```

---

### Task 2: Message caching and retrieval — `WhatsAppClient`

**Files:**
- Modify: `src/whatsapp.ts`

**Interfaces:**
- Consumes: `CachedMessage`, `MessageContentLike`, `describeMessageContent`, `trimHistory`, `isTrackableChat` from Task 1 (`./messages.js`).
- Produces (consumed by Task 3):
  - `WhatsAppClient.getMessages(jid: string, limit: number): Promise<CachedMessage[]>`
  - `WhatsAppClient.listRecentChats(limit: number): Promise<Array<{ jid: string; lastAt: number; preview: string }>>`

- [ ] **Step 1: Add the new imports**

In `src/whatsapp.ts`, the top of the file currently has:

```typescript
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  canonicalJid,
  lidMappingFrom,
  reconcileLidEntries,
  normalizePhoneJid,
  type CachedContact,
} from "./contacts.js";
import { mediaKindForPath, mimeTypeForPath, isLocalFilePath } from "./media.js";
```

Replace it with:

```typescript
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  canonicalJid,
  lidMappingFrom,
  reconcileLidEntries,
  normalizePhoneJid,
  type CachedContact,
} from "./contacts.js";
import { mediaKindForPath, mimeTypeForPath, isLocalFilePath } from "./media.js";
import { describeMessageContent, trimHistory, isTrackableChat, type CachedMessage } from "./messages.js";
```

- [ ] **Step 2: Add the messages directory constant**

Find:

```typescript
const DATA_DIR = path.join(homedir(), ".whatsapp-mcp");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
```

Replace with:

```typescript
const DATA_DIR = path.join(homedir(), ".whatsapp-mcp");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
const MESSAGES_DIR = path.join(DATA_DIR, "messages");
const MAX_MESSAGES_PER_CHAT = 100;
```

- [ ] **Step 3: Create the messages directory on connect, and subscribe to `messages.upsert`**

Find (inside `connect()`):

```typescript
  async connect(): Promise<void> {
    await mkdir(AUTH_DIR, { recursive: true });
    await this.loadContactCache();
```

Replace with:

```typescript
  async connect(): Promise<void> {
    await mkdir(AUTH_DIR, { recursive: true });
    await mkdir(MESSAGES_DIR, { recursive: true });
    await this.loadContactCache();
```

Find:

```typescript
    // WhatsApp can push lid↔pn links independently of contact records.
    sock.ev.on("lid-mapping.update", (m) => void this.learnLidMappings([m]));
  }
```

Replace with:

```typescript
    // WhatsApp can push lid↔pn links independently of contact records.
    sock.ev.on("lid-mapping.update", (m) => void this.learnLidMappings([m]));

    // Only live messages are cached — "append" batches are history sync,
    // and caching those would silently violate the no-backfill design.
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) void this.cacheMessage(msg);
    });
  }
```

- [ ] **Step 4: Add the private caching helpers**

Find the end of `mergeContacts` and the start of `loadContactCache`:

```typescript
    if (changed) await this.saveContactCache();
  }

  private async loadContactCache(): Promise<void> {
```

Replace with:

```typescript
    if (changed) await this.saveContactCache();
  }

  /**
   * Persist one live message to its chat's cache file, trimmed to the last
   * MAX_MESSAGES_PER_CHAT. Best-effort: a failure here must never affect the
   * live connection, so every failure is caught and logged without content.
   */
  private async cacheMessage(msg: WAMessage): Promise<void> {
    const remoteJid = msg.key.remoteJid;
    if (!remoteJid || !isTrackableChat(remoteJid)) return;
    const jid = remoteJid.endsWith("@lid") ? this.lidToPn.get(remoteJid) ?? remoteJid : remoteJid;
    const tsRaw = msg.messageTimestamp;
    const timestamp = (typeof tsRaw === "number" ? tsRaw : Number(tsRaw ?? 0)) * 1000;
    const entry: CachedMessage = {
      fromMe: msg.key.fromMe ?? false,
      timestamp,
      text: describeMessageContent(msg.message),
    };
    try {
      const existing = await this.readChatFile(jid);
      await this.writeChatFile(jid, trimHistory([...existing, entry], MAX_MESSAGES_PER_CHAT));
    } catch {
      console.error("[whatsapp-mcp] failed to persist a cached message");
    }
  }

  private chatFilePath(jid: string): string {
    return path.join(MESSAGES_DIR, `${jid}.json`);
  }

  private async readChatFile(jid: string): Promise<CachedMessage[]> {
    try {
      const raw = JSON.parse(await readFile(this.chatFilePath(jid), "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private async writeChatFile(jid: string, messages: CachedMessage[]): Promise<void> {
    await mkdir(MESSAGES_DIR, { recursive: true });
    await writeFile(this.chatFilePath(jid), JSON.stringify(messages, null, 2));
  }

  private async loadContactCache(): Promise<void> {
```

- [ ] **Step 5: Add the public read methods**

Find the end of `sendMedia` and the closing of the class:

```typescript
      } else {
        await this.sock.sendMessage(jid, {
          document: media,
          mimetype: mimeTypeForPath(filePath),
          fileName: path.basename(filePath),
          caption,
        });
      }
    }
  }
```

Replace with:

```typescript
      } else {
        await this.sock.sendMessage(jid, {
          document: media,
          mimetype: mimeTypeForPath(filePath),
          fileName: path.basename(filePath),
          caption,
        });
      }
    }
  }

  /** The most recent `limit` cached messages for one chat, oldest-first. */
  async getMessages(jid: string, limit: number): Promise<CachedMessage[]> {
    const all = await this.readChatFile(jid);
    return all.slice(Math.max(0, all.length - limit));
  }

  /**
   * Chats with cached activity, newest-first, each with its last message's
   * time and text as a preview. Derived directly from the per-chat files —
   * there is no separate index to keep in sync (see design doc).
   */
  async listRecentChats(limit: number): Promise<Array<{ jid: string; lastAt: number; preview: string }>> {
    let files: string[];
    try {
      files = await readdir(MESSAGES_DIR);
    } catch {
      return [];
    }
    const entries: Array<{ jid: string; lastAt: number; preview: string }> = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const jid = file.slice(0, -".json".length);
      const messages = await this.readChatFile(jid);
      const last = messages[messages.length - 1];
      if (!last) continue;
      entries.push({ jid, lastAt: last.timestamp, preview: last.text });
    }
    entries.sort((a, b) => b.lastAt - a.lastAt);
    return entries.slice(0, limit);
  }
}
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: PASS — no TypeScript errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS — 66 tests, unchanged from Task 1 (this task adds no new unit tests; the I/O wrapper is verified manually in Task 5, matching how `sendMedia`'s I/O wrapper was never unit-tested either).

- [ ] **Step 8: Commit**

```bash
git add src/whatsapp.ts
git commit -m "$(cat <<'EOF'
Cache live 1:1 messages and expose read methods on WhatsAppClient

Subscribes to messages.upsert (notify-only, no history backfill),
persists each trackable message to a per-chat JSON file capped at 100
entries, and adds getMessages/listRecentChats for the upcoming tools.
EOF
)"
```

---

### Task 3: `read_messages` and `list_recent_chats` tools — `src/server.ts`

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `client.getMessages`, `client.listRecentChats` from Task 2; existing `resolveRecipient`, `client.getContacts()`, `client.selfJid()`, `client.selfNumber()`, `notReadyError()`, `ok()`, `err()`.
- Produces: two new MCP tools, `read_messages` and `list_recent_chats`, exercised manually in Task 5.

- [ ] **Step 1: Insert the two new tool registrations**

Find:

```typescript
      const list = results.map((c) => `- ${c.name} (+${c.jid.split("@")[0]})`).join("\n");
      return ok(`Contacts matching "${query}":\n${list}`);
    }
  );

  // ── Tool 3: get_connection_status (read-only, no arguments) ──────────────
```

Replace with:

```typescript
      const list = results.map((c) => `- ${c.name} (+${c.jid.split("@")[0]})`).join("\n");
      return ok(`Contacts matching "${query}":\n${list}`);
    }
  );

  // ── Tool 3: read_messages (read-only) ─────────────────────────────────────
  server.registerTool(
    "read_messages",
    {
      title: "Read WhatsApp message history",
      description:
        "Read cached message history for a WhatsApp chat: plain text and placeholders for " +
        'media (e.g. "[image: caption]", "[voice note]"). `recipient` accepts the same forms ' +
        "as send_message: a contact name (exact match), a phone number, or 'me'. Only messages " +
        "sent or received since this feature started running are available — there is no " +
        "historical backfill. Group chats are not supported. Returns messages oldest-first " +
        "with each line labeled 'You' or the contact's name.",
      inputSchema: {
        recipient: z
          .string()
          .describe("Contact name (exact match), international phone number, or 'me'"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max messages to return, oldest-first (default 20, max 100)"),
      },
    },
    async ({ recipient, limit }) => {
      if (client.status !== "connected") return notReadyError();

      const resolution = resolveRecipient(recipient, client.getContacts());

      let jid: string;
      let peerName: string;

      switch (resolution.kind) {
        case "invalid":
          return err(`Invalid recipient: ${resolution.reason}`);

        case "not_found": {
          const hint =
            resolution.candidates.length > 0
              ? `Close matches: ${resolution.candidates.map((c) => c.name).join(", ")}. ` +
                "Ask the user which one they meant, then call again with that exact name."
              : "No similar contacts found. Try search_contacts, or use a phone number.";
          return err(`No contact named exactly "${recipient}". ${hint}`);
        }

        case "ambiguous": {
          const list = resolution.matches
            .map((m) => `- ${m.name} (+${m.jid.split("@")[0]})`)
            .join("\n");
          return err(
            `Several contacts match "${recipient}" — refusing to guess:\n${list}\n` +
              "Ask the user which one, then call again with the phone number."
          );
        }

        case "self": {
          jid = client.selfJid();
          peerName = "You";
          break;
        }

        case "number": {
          jid = resolution.jid;
          peerName = `+${resolution.jid.split("@")[0]}`;
          break;
        }

        case "resolved": {
          jid = resolution.jid;
          peerName = resolution.name;
          break;
        }
      }

      const messages = await client.getMessages(jid, limit ?? 20);
      if (messages.length === 0) {
        return ok(
          `No cached messages with ${peerName} yet — only messages sent/received since this ` +
            "feature was enabled are available."
        );
      }
      const lines = messages.map((m) => {
        const who = m.fromMe ? "You" : peerName;
        const when = new Date(m.timestamp).toLocaleString();
        return `[${when}] ${who}: ${m.text}`;
      });
      return ok(lines.join("\n"));
    }
  );

  // ── Tool 4: list_recent_chats (read-only, no chat needed) ────────────────
  server.registerTool(
    "list_recent_chats",
    {
      title: "List recently active WhatsApp chats",
      description:
        "List 1:1 WhatsApp chats with cached message activity, newest first. Each entry shows " +
        "the contact name (or phone number if unknown), when the last message arrived, and a " +
        "short preview. Use this to find out what's been happening without already knowing who " +
        "to ask about, then call read_messages on whichever chat matters. Only reflects " +
        "activity since this feature started running.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max chats to return, newest-first (default 20, max 100)"),
      },
    },
    async ({ limit }) => {
      if (client.status !== "connected") return notReadyError();

      const chats = await client.listRecentChats(limit ?? 20);
      if (chats.length === 0) {
        return ok("No cached message activity yet.");
      }
      const contactsByJid = new Map(client.getContacts().map((c) => [c.jid, c.name]));
      const lines = chats.map((c) => {
        const name = contactsByJid.get(c.jid) ?? `+${c.jid.split("@")[0]}`;
        const when = new Date(c.lastAt).toLocaleString();
        return `- ${name} — ${when} — ${c.preview}`;
      });
      return ok(lines.join("\n"));
    }
  );

  // ── Tool 5: get_connection_status (read-only, no arguments) ──────────────
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — no TypeScript errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — 66 tests, unchanged (no new unit tests for tool registrations, consistent with the existing three tools).

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "$(cat <<'EOF'
Add read_messages and list_recent_chats MCP tools

Lets an agent look up cached history for a chat, or see which chats have
recent activity without already knowing who to ask about. Recipient
resolution in read_messages reuses send_message's exact logic.
EOF
)"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/design-plan.md`

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing consumed by other tasks — Task 5's manual E2E follows these steps.

- [ ] **Step 1: Extend the E2E verification checklist**

Find (in `docs/design-plan.md`, the "Real E2E in Claude Code" verification item):

```
4. **Real E2E in Claude Code:** `claude mcp add whatsapp -- node ~/whatsapp-mcp/dist/index.js`, restart, then: send to `"me"` → verify on phone; `search_contacts("<a saved contact name>")` → correct match; send to ambiguous name (e.g. a name shared by two contacts) → confirm it REFUSES and lists candidates (regression test for today's incident); send to a raw phone number → delivered; send an image, a video, and a document (each with and without a caption) to `"me"` → confirm all three arrive with the correct type (images/video render inline, not as a generic file icon) and that captions show up when given.
```

Replace with:

```
4. **Real E2E in Claude Code:** `claude mcp add whatsapp -- node ~/whatsapp-mcp/dist/index.js`, restart, then: send to `"me"` → verify on phone; `search_contacts("<a saved contact name>")` → correct match; send to ambiguous name (e.g. a name shared by two contacts) → confirm it REFUSES and lists candidates (regression test for today's incident); send to a raw phone number → delivered; send an image, a video, and a document (each with and without a caption) to `"me"` → confirm all three arrive with the correct type (images/video render inline, not as a generic file icon) and that captions show up when given; have a real contact send a text message, an image with a caption, and a voice note → call `read_messages(<that contact>)` and confirm all three appear correctly, oldest-first, labeled with the right sender; call `list_recent_chats()` and confirm that chat appears with an accurate preview; restart the MCP server and re-run both → confirm the cached history survived the restart.
```

- [ ] **Step 2: Commit**

```bash
git add docs/design-plan.md
git commit -m "Add read_messages/list_recent_chats steps to the E2E verification checklist"
```

---

### Task 5: Final regression check and push

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: PASS — no TypeScript errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — 66 tests, pristine output (no warnings).

- [ ] **Step 3: Confirm nothing is left uncommitted**

Run: `git status --short`
Expected: empty output. (A prior plan in this repo once left a doc uncommitted at this stage — this step exists specifically to catch that class of mistake.)

- [ ] **Step 4: Push**

```bash
git push
```

Expected: `origin/main` fast-forwards to the new commits, no conflicts.

- [ ] **Step 5: Manual E2E (cannot be automated — requires a live WhatsApp session and a real contact)**

Follow the extended checklist item from Task 4: have a real contact send a text, an image with a caption, and a voice note; call `read_messages` and `list_recent_chats`; restart the MCP server; confirm history survived. Report results before considering this plan complete.
