// ─── The MCP layer ───────────────────────────────────────────────────────────
//
// If you're reading this repo to learn MCP, THIS is the file to study.
//
// An MCP *server* is a small program that exposes capabilities ("tools") to an
// MCP *client* embedded in a host app (Claude Code, Claude Desktop, etc.).
// The host spawns us as a child process and speaks JSON-RPC 2.0 with us over
// stdin/stdout — that's the "stdio transport". Coming from Kotlin/KMP: think
// of it as exposing a typed service interface over IPC, where the tool
// schemas below are the interface contract the client discovers at runtime.
//
// Two rules that trip everyone up:
//  1. stdout belongs to the protocol. Log ONLY to stderr (see whatsapp.ts).
//  2. Tool names + descriptions are read by the LLM to decide when/how to
//     call you — they are prompts. Write them like documentation, not like
//     variable names.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import qrcode from "qrcode-terminal";
import path from "node:path";
import { WhatsAppClient } from "./whatsapp.js";
import { resolveRecipient, searchContacts } from "./contacts.js";

/** Tool results are lists of typed content blocks; these two helpers cover
 *  the only shapes we need. `isError: true` tells the model the call failed
 *  in a way it can read and react to (e.g. re-ask the user for a recipient). */
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

function renderQrAscii(qr: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(qr, { small: true }, resolve));
}

export async function runServer(): Promise<void> {
  const client = new WhatsAppClient();
  // Connect eagerly so the socket is usually open before the first tool call
  // — but DON'T await it: MCP initialization must not block on WhatsApp.
  void client.connect().catch(() => {});

  /** Shared guard: every tool starts by checking the WhatsApp session. */
  async function notReadyError() {
    if (client.status === "logged_out") {
      return err(
        "WhatsApp session was logged out from the phone. Ask the user to run " +
          "`npx whatsapp-mcp login` in a terminal to pair again."
      );
    }
    if (client.currentQr) {
      // Unpaired but a live QR exists — surface it right in the chat so the
      // user can scan without opening a terminal at all.
      const ascii = await renderQrAscii(client.currentQr);
      return err(
        "WhatsApp is not paired yet. The user can either scan this QR now " +
          "(WhatsApp → Settings → Linked Devices → Link a Device; it refreshes " +
          "every ~20s, retry the tool for a fresh one), or run " +
          "`npx whatsapp-mcp login` in a terminal:\n\n```\n" + ascii + "\n```"
      );
    }
    return err(
      "WhatsApp connection is still starting up (or the network is down). " +
        "Wait a couple of seconds and try again."
    );
  }

  const server = new McpServer({ name: "whatsapp-mcp", version: "0.1.0" });

  // ── Tool 1: send_message ──────────────────────────────────────────────────
  // The zod shape below does triple duty: the SDK turns it into JSON Schema
  // for the client, validates incoming arguments against it, and derives the
  // TypeScript types of the handler's parameters.
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
        "+962791234567), or 'me' to message the user's own self-chat. A phone number that " +
        "isn't a saved contact is refused on the first call — the error asks you to confirm " +
        "with the user, then call again with `confirmed: true`; this exists because a saved " +
        "contact's name can collide with an unrelated WhatsApp account (e.g. someone's " +
        "self-set display name), so a bare number deserves the same caution. Provide " +
        "`message`, `file_path`, or both — when both are given, `message` becomes the file's " +
        "caption. Media type is auto-detected from the file's extension; unrecognized " +
        "extensions are sent as a generic document. The result confirms exactly who/what was " +
        "sent. Never retry a failed send blindly — read the error, it tells you what to fix. " +
        "Sending is a real-world side effect: unless the user explicitly dictated both the " +
        "recipient and the exact message/file, confirm with them before calling this.",
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
        confirmed: z
          .boolean()
          .optional()
          .describe(
            "Required (set to true) to send to a phone number that is not a saved contact. " +
              "Omit on the first attempt; only set this after the user has explicitly " +
              "confirmed that number is correct."
          ),
      },
    },
    async ({ recipient, message, file_path, confirmed }) => {
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
          if (!confirmed) {
            return err(
              `+${resolution.jid.split("@")[0]} is not a saved contact. Confirm with the user ` +
                "that this is the number they mean, then call again with confirmed: true."
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

  // ── Tool 2: search_contacts (read-only) ───────────────────────────────────
  server.registerTool(
    "search_contacts",
    {
      title: "Search WhatsApp contacts",
      description:
        "Search the user's WhatsApp contacts by name (case-insensitive substring). " +
        "Returns matching names with phone numbers. Use this to resolve the exact " +
        "contact name before send_message when the user gives a partial or uncertain name.",
      inputSchema: {
        query: z.string().min(1).describe("Name fragment to search for"),
      },
    },
    async ({ query }) => {
      if (client.status !== "connected") return notReadyError();

      const results = searchContacts(query, client.getContacts(), 20);
      if (results.length === 0) {
        return ok(`No contacts matching "${query}".`);
      }
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
  // Lets the model check state proactively ("is WhatsApp even connected?")
  // instead of discovering problems by having a send fail.
  server.registerTool(
    "get_connection_status",
    {
      title: "WhatsApp connection status",
      description:
        "Check whether the WhatsApp session is connected and paired. Returns the " +
        "connection state, whether a QR scan is needed, and how many contacts are " +
        "synced. Call this first if a send fails unexpectedly or before a batch of sends.",
      inputSchema: {},
    },
    async () => {
      const lines = [
        `status: ${client.status}`,
        `paired: ${WhatsAppClient.isPaired()}`,
        `needs_qr_scan: ${client.currentQr !== null}`,
        `contacts_synced: ${client.getContacts().length}`,
      ];
      if (client.status === "connected") lines.push(`account: ${client.selfNumber()}`);
      return ok(lines.join("\n"));
    }
  );

  // Wire the server to stdin/stdout and start serving. From here on, the
  // host app drives everything: it calls tools/list to discover our schemas,
  // then tools/call whenever the model decides to use one.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
