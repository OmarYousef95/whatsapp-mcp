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
        "Send a WhatsApp text message from the user's personal account. " +
        "`recipient` accepts: a contact name (must match EXACTLY one saved contact, " +
        "case-insensitive — if zero or several match, the call fails and lists the " +
        "candidates so you can ask the user which one they meant), a phone number in " +
        "international format (e.g. +962791234567), or 'me' to message the user's own " +
        "self-chat. The result confirms exactly who the message went to. " +
        "Never retry a failed send blindly — read the error, it tells you what to fix. " +
        "Sending is a real-world side effect: unless the user explicitly dictated both " +
        "the recipient and the exact message, confirm with them before calling this.",
      inputSchema: {
        recipient: z
          .string()
          .describe("Contact name (exact match), international phone number, or 'me'"),
        message: z.string().min(1).describe("The text message to send"),
      },
    },
    async ({ recipient, message }) => {
      if (client.status !== "connected") return notReadyError();

      const resolution = resolveRecipient(recipient, client.getContacts());

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
          const jid = client.selfJid();
          await client.sendText(jid, message);
          return ok(`Sent to your own self-chat (${client.selfNumber()}): "${message}"`);
        }

        case "number": {
          if (!(await client.numberExists(resolution.jid))) {
            return err(
              `+${resolution.jid.split("@")[0]} is not registered on WhatsApp — nothing sent.`
            );
          }
          await client.sendText(resolution.jid, message);
          return ok(`Sent to +${resolution.jid.split("@")[0]}: "${message}"`);
        }

        case "resolved": {
          await client.sendText(resolution.jid, message);
          return ok(
            `Sent to ${resolution.name} (+${resolution.jid.split("@")[0]}): "${message}"`
          );
        }
      }
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

  // ── Tool 3: get_connection_status (read-only, no arguments) ──────────────
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
