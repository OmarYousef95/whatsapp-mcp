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
