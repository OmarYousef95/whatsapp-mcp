# send_media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing `send_message` MCP tool send a local image/video/document (optionally with a caption), not just plain text.

**Architecture:** A new pure module `src/media.ts` (no I/O, unit-tested — matches `src/contacts.ts`'s convention) decides which Baileys media field a file belongs under, from its extension. `WhatsAppClient.sendMedia` (new method in `src/whatsapp.ts`, alongside the existing `sendText`) wires that into a `sock.sendMessage` call. `server.ts`'s `send_message` tool gains an optional `file_path` param; `message` doubles as the caption when both are given.

**Tech Stack:** TypeScript (NodeNext modules — local imports need `.js`), Baileys 7.x (`@whiskeysockets/baileys`), zod for the tool schema, vitest for tests.

## Global Constraints

- Strict TypeScript, NodeNext module resolution: every local import ends in `.js` (e.g. `./media.js`), even though the source file is `.ts`.
- Tests run via `npm test` (`vitest run`). Pure logic gets a dedicated unit test file; I/O-heavy code (`whatsapp.ts`, `server.ts`) has no unit tests in this repo today — verified by manual E2E instead. Follow that existing split; don't add tests for `sendMedia` or the tool handler itself.
- No new dependencies — `@whiskeysockets/baileys` (already installed, `^7.0.0-rc13`) natively supports `image`/`video`/`document` sends from a local path via `{ url: filePath }`.
- No client-side file-size validation (explicit decision, see spec) — any send failure, including oversized files, surfaces via one try/catch around `sendMedia`, not a pre-check.
- No separate `caption` parameter — `message` is reused as the caption when `file_path` is also present.
- Local file paths only in v1 — no remote URL support.
- Out of scope for v1: audio/voice notes, stickers (Baileys supports them; not built here).
- Spec: `docs/superpowers/specs/2026-07-10-send-media-design.md` — read it if any task instruction below seems to contradict it; the spec is source of truth for intent, this plan is source of truth for exact code.

---

### Task 1: Media type detection — `src/media.ts`

**Files:**
- Create: `src/media.ts`
- Create: `src/media.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no dependencies on other project code).
- Produces:
  - `export type MediaKind = "image" | "video" | "document";`
  - `export function mediaKindForPath(filePath: string): MediaKind`
  - `export function mimeTypeForPath(filePath: string): string`

- [ ] **Step 1: Write the failing test file**

Create `src/media.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mediaKindForPath, mimeTypeForPath } from "./media.js";

describe("mediaKindForPath", () => {
  it("detects common image extensions", () => {
    expect(mediaKindForPath("photo.jpg")).toBe("image");
    expect(mediaKindForPath("photo.jpeg")).toBe("image");
    expect(mediaKindForPath("photo.png")).toBe("image");
    expect(mediaKindForPath("photo.gif")).toBe("image");
    expect(mediaKindForPath("photo.webp")).toBe("image");
  });

  it("detects common video extensions", () => {
    expect(mediaKindForPath("clip.mp4")).toBe("video");
    expect(mediaKindForPath("clip.mov")).toBe("video");
    expect(mediaKindForPath("clip.3gp")).toBe("video");
    expect(mediaKindForPath("clip.avi")).toBe("video");
    expect(mediaKindForPath("clip.mkv")).toBe("video");
  });

  it("is case-insensitive", () => {
    expect(mediaKindForPath("PHOTO.JPG")).toBe("image");
    expect(mediaKindForPath("Clip.MP4")).toBe("video");
  });

  it("falls back to document for unrecognized extensions", () => {
    expect(mediaKindForPath("report.pdf")).toBe("document");
    expect(mediaKindForPath("archive.zip")).toBe("document");
    expect(mediaKindForPath("notes.csv")).toBe("document");
  });

  it("falls back to document when there is no extension", () => {
    expect(mediaKindForPath("README")).toBe("document");
    expect(mediaKindForPath("/tmp/some-file")).toBe("document");
  });

  it("falls back to document for a dotfile with no other extension", () => {
    expect(mediaKindForPath(".gitignore")).toBe("document");
  });

  it("uses the file's own extension, ignoring dots in directory names", () => {
    expect(mediaKindForPath("/Users/example.name/Desktop/photo.jpg")).toBe("image");
    expect(mediaKindForPath("/Users/example.name/Desktop/report.pdf")).toBe("document");
  });

  it("resolves a Windows-style path", () => {
    expect(mediaKindForPath("C:\\Users\\example\\Pictures\\photo.png")).toBe("image");
  });
});

describe("mimeTypeForPath", () => {
  it("maps known extensions to their MIME type", () => {
    expect(mimeTypeForPath("photo.jpg")).toBe("image/jpeg");
    expect(mimeTypeForPath("clip.mp4")).toBe("video/mp4");
    expect(mimeTypeForPath("report.pdf")).toBe("application/pdf");
    expect(mimeTypeForPath("notes.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  it("is case-insensitive", () => {
    expect(mimeTypeForPath("PHOTO.JPG")).toBe("image/jpeg");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(mimeTypeForPath("archive.xyz")).toBe("application/octet-stream");
    expect(mimeTypeForPath("README")).toBe("application/octet-stream");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/media.test.ts`
Expected: FAIL — `Error: Cannot find module './media.js'` (or similar resolution error), because `src/media.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/media.ts`:

```typescript
// Pure media-type detection logic. No I/O — matches contacts.ts's convention
// of keeping decision logic in small, fully unit-tested, dependency-free
// functions.
//
// WhatsApp (via Baileys) has distinct message types for image/video/document;
// picking the right one is required for media to render correctly on the
// recipient's phone (an image sent as a "document" shows as a bare file icon
// instead of inline). Detection is extension-based: good enough for the
// common case, and anything unrecognized safely falls back to "document" —
// WhatsApp's generic file container that accepts any file type.

export type MediaKind = "image" | "video" | "document";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".3gp", ".avi", ".mkv"]);

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".3gp": "video/3gpp",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

const DEFAULT_MIME_TYPE = "application/octet-stream";

/**
 * The extension of a file path, lowercased, including the leading dot
 * ("" if there is none). Only looks at the basename, so dots in directory
 * names (e.g. "example.name") are never mistaken for the file's extension.
 * A leading dot with nothing before it (".gitignore") is not an extension.
 */
function extensionOf(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/** Which Baileys media field to send a file under, based on its extension. */
export function mediaKindForPath(filePath: string): MediaKind {
  const ext = extensionOf(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "document";
}

/**
 * MIME type for a file path, used for the Baileys `document` field (which
 * requires one explicitly). Falls back to a generic binary type when the
 * extension is unknown.
 */
export function mimeTypeForPath(filePath: string): string {
  const ext = extensionOf(filePath);
  return MIME_TYPES[ext] ?? DEFAULT_MIME_TYPE;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/media.test.ts`
Expected: PASS — all `describe`/`it` blocks green (11 tests: 8 under `mediaKindForPath`, 3 under `mimeTypeForPath`).

- [ ] **Step 5: Commit**

```bash
git add src/media.ts src/media.test.ts
git commit -m "$(cat <<'EOF'
Add media type detection for send_media

Pure, unit-tested logic deciding whether a file path is an image, video,
or generic document (by extension), plus its MIME type for the document
case. No I/O — mirrors contacts.ts's existing convention.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `WhatsAppClient.sendMedia` — `src/whatsapp.ts`

**Files:**
- Modify: `src/whatsapp.ts:17-23` (imports), `src/whatsapp.ts:229-233` (append new method after `sendText`)

**Interfaces:**
- Consumes: `mediaKindForPath(filePath: string): MediaKind`, `mimeTypeForPath(filePath: string): string` from `./media.js` (Task 1).
- Produces: `WhatsAppClient.sendMedia(jid: string, filePath: string, caption?: string): Promise<void>`

- [ ] **Step 1: Add the import**

In `src/whatsapp.ts`, the existing import block (lines 17-23) is:

```typescript
import {
  canonicalJid,
  lidMappingFrom,
  reconcileLidEntries,
  normalizePhoneJid,
  type CachedContact,
} from "./contacts.js";
```

Add directly below it:

```typescript
import { mediaKindForPath, mimeTypeForPath } from "./media.js";
```

- [ ] **Step 2: Add the `sendMedia` method**

The existing `sendText` method (lines 229-233) is:

```typescript
  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock || this.status !== "connected") throw new Error("not connected");
    await this.sock.sendMessage(jid, { text });
  }
}
```

Replace it with (adds `sendMedia` after `sendText`, keeping the closing class brace):

```typescript
  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock || this.status !== "connected") throw new Error("not connected");
    await this.sock.sendMessage(jid, { text });
  }

  /**
   * Send a local file as an image, video, or document, auto-detected from
   * its extension (see media.ts). Baileys reads the file itself from
   * `{ url: filePath }` — no manual buffering needed. Any failure (file not
   * found, unsupported/corrupt file, network error, file too large) throws
   * and is surfaced by the caller (server.ts) as a tool error — there is no
   * pre-flight existence or size check here by design.
   */
  async sendMedia(jid: string, filePath: string, caption?: string): Promise<void> {
    if (!this.sock || this.status !== "connected") throw new Error("not connected");
    const kind = mediaKindForPath(filePath);
    const media = { url: filePath };
    if (kind === "image") {
      await this.sock.sendMessage(jid, { image: media, caption });
    } else if (kind === "video") {
      await this.sock.sendMessage(jid, { video: media, caption });
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

Note: `path` is already imported in this file (`import path from "node:path";`, line 16) — no new import needed for `path.basename`.

- [ ] **Step 3: Verify the project still builds and existing tests still pass**

Run: `npm run build`
Expected: exits 0, no output (tsc compiles cleanly — this also type-checks the new method against Baileys' `AnyMediaMessageContent` type).

Run: `npm test`
Expected: PASS — all existing `contacts.test.ts` tests plus the `media.test.ts` tests from Task 1 (this task adds no new test file, since `whatsapp.ts` has no unit tests in this repo — see Global Constraints).

- [ ] **Step 4: Commit**

```bash
git add src/whatsapp.ts
git commit -m "$(cat <<'EOF'
Add WhatsAppClient.sendMedia

Sends a local file as an image, video, or document via Baileys, picking
the right message field from media.ts's extension-based detection. No
pre-flight existence/size checks — failures surface to the caller as-is.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extend the `send_message` tool — `src/server.ts`

**Files:**
- Modify: `src/server.ts:1-23` (imports), `src/server.ts:72-145` (the entire `send_message` tool registration)

**Interfaces:**
- Consumes: `client.sendMedia(jid, filePath, caption?)` (Task 2); existing `resolveRecipient`, `client.sendText`, `client.numberExists`, `client.selfJid`, `client.selfNumber`, `client.getContacts` (all unchanged).
- Produces: `send_message` tool now accepts an optional `file_path` param; behavior for text-only calls is unchanged.

- [ ] **Step 1: Add the `path` import**

At the top of `src/server.ts`, the existing imports (lines 18-23) are:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import qrcode from "qrcode-terminal";
import { WhatsAppClient } from "./whatsapp.js";
import { resolveRecipient, searchContacts } from "./contacts.js";
```

Add `node:path` to them:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import qrcode from "qrcode-terminal";
import path from "node:path";
import { WhatsAppClient } from "./whatsapp.js";
import { resolveRecipient, searchContacts } from "./contacts.js";
```

- [ ] **Step 2: Replace the entire `send_message` tool registration**

Replace the whole block from `server.registerTool(\n    "send_message",` through its closing `);` (lines 72-145 in the current file) with:

```typescript
  server.registerTool(
    "send_message",
    {
      title: "Send WhatsApp message",
      description:
        "Send a WhatsApp message from the user's personal account: plain text, a local " +
        "file (image, video, or document), or a file with a caption. `recipient` accepts: " +
        "a contact name (must match EXACTLY one saved contact, case-insensitive — if zero " +
        "or several match, the call fails and lists the candidates so you can ask the user " +
        "which one they meant), a phone number in international format (e.g. " +
        "+962791234567), or 'me' to message the user's own self-chat. Provide `message`, " +
        "`file_path`, or both — when both are given, `message` becomes the file's caption. " +
        "Media type is auto-detected from the file's extension; unrecognized extensions are " +
        "sent as a generic document. The result confirms exactly who/what was sent. Never " +
        "retry a failed send blindly — read the error, it tells you what to fix. Sending is " +
        "a real-world side effect: unless the user explicitly dictated both the recipient " +
        "and the exact message/file, confirm with them before calling this.",
      inputSchema: {
        recipient: z
          .string()
          .describe("Contact name (exact match), international phone number, or 'me'"),
        message: z
          .string()
          .optional()
          .describe(
            "The text message to send. Required unless file_path is given; when both " +
              "are given, this becomes the file's caption."
          ),
        file_path: z
          .string()
          .optional()
          .describe(
            "Absolute local path to an image, video, or other file to send. Media type " +
              "is auto-detected from the extension; unrecognized extensions are sent as " +
              "a generic document."
          ),
      },
    },
    async ({ recipient, message, file_path }) => {
      if (!message && !file_path) {
        return err("Provide a message, a file_path, or both.");
      }
      if (client.status !== "connected") return notReadyError();

      const resolution = resolveRecipient(recipient, client.getContacts());

      let jid: string;
      let label: string;

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
          label = `your own self-chat (${client.selfNumber()})`;
          break;
        }

        case "number": {
          if (!(await client.numberExists(resolution.jid))) {
            return err(
              `+${resolution.jid.split("@")[0]} is not registered on WhatsApp — nothing sent.`
            );
          }
          jid = resolution.jid;
          label = `+${resolution.jid.split("@")[0]}`;
          break;
        }

        case "resolved": {
          jid = resolution.jid;
          label = `${resolution.name} (+${resolution.jid.split("@")[0]})`;
          break;
        }
      }

      if (file_path) {
        try {
          await client.sendMedia(jid, file_path, message);
        } catch (e) {
          return err(`Failed to send file: ${(e as Error).message}`);
        }
        const captionNote = message ? ` with caption: "${message}"` : "";
        return ok(`Sent ${path.basename(file_path)} to ${label}${captionNote}`);
      }

      await client.sendText(jid, message!);
      return ok(`Sent to ${label}: "${message}"`);
    }
  );
```

- [ ] **Step 3: Verify build and full test suite**

Run: `npm run build`
Expected: exits 0, no output.

Run: `npm test`
Expected: PASS — same test count as after Task 2 (this task adds no new test file; `server.ts` has no unit tests in this repo — see Global Constraints. The `search_contacts` and `get_connection_status` tool registrations below `send_message` in the file are untouched).

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "$(cat <<'EOF'
Extend send_message to send local files

Adds an optional file_path param: text-only, file-only, or file+caption
(message doubles as the caption) all go through the same tool, reusing
the exact recipient-resolution logic that already existed for text.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Update the manual verification checklist — `docs/design-plan.md`

**Files:**
- Modify: `docs/design-plan.md:75`

**Interfaces:**
- Consumes: nothing.
- Produces: an updated verification step covering media sends, for whoever runs the manual E2E pass (the user, right after this plan finishes).

- [ ] **Step 1: Extend the E2E verification step**

The current line 75 reads:

```markdown
4. **Real E2E in Claude Code:** `claude mcp add whatsapp -- node ~/whatsapp-mcp/dist/index.js`, restart, then: send to `"me"` → verify on phone; `search_contacts("<a saved contact name>")` → correct match; send to ambiguous name (e.g. a name shared by two contacts) → confirm it REFUSES and lists candidates (regression test for today's incident); send to a raw phone number → delivered.
```

Replace it with:

```markdown
4. **Real E2E in Claude Code:** `claude mcp add whatsapp -- node ~/whatsapp-mcp/dist/index.js`, restart, then: send to `"me"` → verify on phone; `search_contacts("<a saved contact name>")` → correct match; send to ambiguous name (e.g. a name shared by two contacts) → confirm it REFUSES and lists candidates (regression test for today's incident); send to a raw phone number → delivered; send an image, a video, and a document (each with and without a caption) to `"me"` → confirm all three arrive with the correct type (images/video render inline, not as a generic file icon) and that captions show up when given.
```

- [ ] **Step 2: Commit**

```bash
git add docs/design-plan.md
git commit -m "$(cat <<'EOF'
Add media send steps to the E2E verification checklist

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Final regression check and push

**Files:** none (verification + push only).

**Interfaces:** none — this task consumes the fully assembled feature from Tasks 1-4 and produces a pushed `main` branch.

- [ ] **Step 1: Run the full test suite one more time**

Run: `npm test`
Expected: PASS — all tests green (contacts.test.ts + media.test.ts).

- [ ] **Step 2: Run the build one more time**

Run: `npm run build`
Expected: exits 0, no output.

- [ ] **Step 3: Review the full diff since the last push**

Run: `git log origin/main..HEAD --oneline`
Expected: the 4 commits from Tasks 1-4, in order (media detection, sendMedia, send_message tool, docs).

- [ ] **Step 4: Push**

Run: `git push origin main`
Expected: `main -> main` fast-forward push succeeds (no force needed — these are new commits on top of the current remote tip).

- [ ] **Step 5: Hand off to the user for live testing**

Tell the user the push is done and that `send_message` now accepts an optional `file_path` (and that `message` doubles as caption when both are given), so they can restart their MCP client (Claude Desktop/Claude Code) to pick up the new `dist/` build — reminding them to run `npm run build` first if their MCP client launches the server directly from `dist/index.js` rather than via `tsx`.
