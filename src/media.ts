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

import path from "node:path";

export type MediaKind = "image" | "video" | "document";

/**
 * True when a path is safe to pass to Baileys as a local file — an absolute
 * filesystem path with no URI scheme. Baileys treats `{ url }` media
 * payloads as either a local path or an http(s) URL; without this guard, a
 * caller could smuggle in a remote URL and make the server fetch
 * attacker-controlled content (SSRF-shaped) instead of sending a local
 * file, defeating the "local file paths only" design intent.
 */
export function isLocalFilePath(filePath: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath)) return false;
  return path.isAbsolute(filePath);
}

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
