// Baileys wrapper: owns the WhatsApp socket, session persistence, and the
// on-disk contact cache. Everything WhatsApp-specific lives here so the MCP
// layer (server.ts) stays a thin, readable protocol tutorial.

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

// Session + cache live OUTSIDE any repo checkout so credentials can never be
// committed by accident. ~/.whatsapp-mcp/auth holds the paired session
// (equivalent of a "linked device"); delete that folder to unpair.
const DATA_DIR = path.join(homedir(), ".whatsapp-mcp");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
const MESSAGES_DIR = path.join(DATA_DIR, "messages");
const MAX_MESSAGES_PER_CHAT = 100;

// CRITICAL for MCP stdio servers: stdout carries the JSON-RPC protocol, so
// every log line must go to stderr (fd 2) or the client sees corrupt frames.
const logger = pino({ level: process.env.WHATSAPP_MCP_LOG_LEVEL ?? "silent" }, pino.destination(2));

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "logged_out";

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private contacts = new Map<string, string>(); // canonical (phone) jid -> display name
  // "@lid" JID -> phone JID. WhatsApp identifies each person by both a phone
  // number and a privacy "LID"; this maps the latter to the former so a person
  // is cached once, under their canonical phone JID (see contacts.ts).
  private lidToPn = new Map<string, string>();
  status: ConnectionStatus = "disconnected";
  /** Latest pairing QR payload, present only while unpaired and connecting. */
  currentQr: string | null = null;
  /** Fires on every fresh QR — used by the login CLI to render it. */
  onQr: ((qr: string) => void) | null = null;
  /** Fires once the socket is fully open. */
  onOpen: (() => void) | null = null;

  static isPaired(): boolean {
    return existsSync(path.join(AUTH_DIR, "creds.json"));
  }

  async connect(): Promise<void> {
    await mkdir(AUTH_DIR, { recursive: true });
    await mkdir(MESSAGES_DIR, { recursive: true });
    await this.loadContactCache();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    this.status = "connecting";
    const sock = makeWASocket({ auth: state, logger });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      // A superseded socket can still fire late events after a newer one has
      // taken over (Baileys doesn't tear down old listeners on reconnect).
      // Acting on those causes duplicate reconnects, which WhatsApp then
      // kills as a session conflict — an endless connect/disconnect flap.
      if (this.sock !== sock) return;

      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        this.currentQr = qr;
        this.onQr?.(qr);
      }

      if (connection === "open") {
        this.status = "connected";
        this.currentQr = null;
        // Clean up any duplicates the old code left in the cache: resolve every
        // "@lid" entry through Baileys' authoritative lid→pn store and collapse.
        void this.reconcileExistingLids(sock);
        this.onOpen?.();
      }

      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        console.error(`[whatsapp-mcp] connection closed (code ${code ?? "unknown"}), reconnecting`);
        if (code === DisconnectReason.loggedOut) {
          // Session was revoked from the phone — reconnecting would loop
          // forever on a dead session. User must pair again.
          this.status = "logged_out";
        } else {
          this.status = "connecting";
          // Transient drop (network, server restart): reconnect with a fresh
          // socket. Baileys requires a new makeWASocket per attempt.
          setTimeout(() => void this.connect().catch(() => (this.status = "disconnected")), 2000);
        }
      }
    });

    // Contacts arrive as sync events (there is no getContacts() call in
    // Baileys) — merge every batch into the cache and persist it.
    sock.ev.on("contacts.upsert", (batch) => void this.mergeContacts(batch));
    sock.ev.on("contacts.update", (batch) => void this.mergeContacts(batch));
    sock.ev.on("messaging-history.set", ({ contacts, lidPnMappings }) => {
      if (lidPnMappings?.length) void this.learnLidMappings(lidPnMappings);
      void this.mergeContacts(contacts ?? []);
    });
    // WhatsApp can push lid↔pn links independently of contact records.
    sock.ev.on("lid-mapping.update", (m) => void this.learnLidMappings([m]));

    // Only live messages are cached — "append" batches are history sync,
    // and caching those would silently violate the no-backfill design.
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) void this.cacheMessage(msg);
    });
  }

  /**
   * Fold a batch of lid↔pn pairs into the mapping, then reconcile the cache so
   * any now-resolvable "@lid" duplicate collapses onto its phone JID.
   */
  private async learnLidMappings(pairs: Array<{ lid: string; pn: string }>): Promise<void> {
    let learned = false;
    for (const { lid, pn } of pairs) {
      if (!lid || !pn) continue;
      const pnJid = normalizePhoneJid(pn);
      if (this.lidToPn.get(lid) !== pnJid) {
        this.lidToPn.set(lid, pnJid);
        learned = true;
      }
    }
    if (!learned) return;
    const before = this.contacts.size;
    this.contacts = reconcileLidEntries(this.contacts, this.lidToPn);
    if (this.contacts.size !== before) await this.saveContactCache();
  }

  /** Resolve the "@lid" keys already in the cache via Baileys' lid→pn store. */
  private async reconcileExistingLids(sock: WASocket): Promise<void> {
    const lids = [...this.contacts.keys()].filter((k) => k.endsWith("@lid"));
    if (lids.length === 0) return;
    try {
      const pairs = await sock.signalRepository.lidMapping.getPNsForLIDs(lids);
      if (pairs?.length) await this.learnLidMappings(pairs);
    } catch {
      // Store not ready yet or offline — the events above will fill it in later.
    }
  }

  private async mergeContacts(
    batch: Array<{
      id?: string;
      lid?: string;
      phoneNumber?: string;
      name?: string;
      notify?: string;
      verifiedName?: string;
    }>
  ): Promise<void> {
    let changed = false;
    let learnedMapping = false;
    for (const c of batch) {
      if (!c.id) continue;
      // A record carrying both a lid and a phone number teaches us the link.
      const mapping = lidMappingFrom({ id: c.id, lid: c.lid, phoneNumber: c.phoneNumber });
      if (mapping && this.lidToPn.get(mapping.lid) !== mapping.pn) {
        this.lidToPn.set(mapping.lid, mapping.pn);
        learnedMapping = true;
      }
      const name = c.name ?? c.verifiedName ?? c.notify;
      if (!name) continue;
      // Store under the canonical phone JID, never a raw LID, so one person
      // yields one cache entry (see the LID note in contacts.ts).
      const key = canonicalJid({ id: c.id, lid: c.lid, phoneNumber: c.phoneNumber }, this.lidToPn);
      if (this.contacts.get(key) !== name) {
        this.contacts.set(key, name);
        changed = true;
      }
    }
    // A newly learned mapping can retire a stale "@lid" entry stored earlier.
    if (learnedMapping) {
      const before = this.contacts.size;
      this.contacts = reconcileLidEntries(this.contacts, this.lidToPn);
      if (this.contacts.size !== before) changed = true;
    }
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
    try {
      const raw = JSON.parse(await readFile(CONTACTS_FILE, "utf8")) as Record<string, string>;
      this.contacts = new Map(Object.entries(raw));
    } catch {
      this.contacts = new Map(); // first run: no cache yet
    }
  }

  private async saveContactCache(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CONTACTS_FILE, JSON.stringify(Object.fromEntries(this.contacts), null, 2));
  }

  getContacts(): CachedContact[] {
    return [...this.contacts.entries()].map(([jid, name]) => ({ jid, name }));
  }

  /** Own JID, normalized (strips the device suffix Baileys includes). */
  selfJid(): string {
    if (!this.sock?.user?.id) throw new Error("not connected");
    return jidNormalizedUser(this.sock.user.id);
  }

  /** Human-readable own number, for confirmations. */
  selfNumber(): string {
    return "+" + this.selfJid().split("@")[0];
  }

  /**
   * Alternative to QR pairing: an 8-character code the user types into
   * WhatsApp ("Link with phone number instead"). Sidesteps terminal-font
   * QR rendering problems entirely. Call only while unpaired.
   */
  async requestPairingCode(phoneDigits: string): Promise<string> {
    if (!this.sock) throw new Error("not connected");
    return this.sock.requestPairingCode(phoneDigits);
  }

  /** True if the number behind this JID is registered on WhatsApp. */
  async numberExists(jid: string): Promise<boolean> {
    if (!this.sock) throw new Error("not connected");
    const results = await this.sock.onWhatsApp(jid);
    return results?.[0]?.exists ?? false;
  }

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
    if (!isLocalFilePath(filePath)) {
      throw new Error(`file_path must be an absolute local path, not a URL: ${filePath}`);
    }
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
