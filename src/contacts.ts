// Pure contact-resolution logic. No I/O here — that keeps it unit-testable
// and keeps the safety-critical decision ("who are we actually about to
// message?") in one small, fully-tested place.
//
// Design rule learned the hard way: NEVER guess a recipient. An input that
// doesn't resolve to exactly one contact is an error the caller must surface,
// not a best-effort pick.

export interface CachedContact {
  jid: string;
  name: string;
}

export type Resolution =
  | { kind: "resolved"; jid: string; name: string }
  | { kind: "self" }
  | { kind: "number"; jid: string }
  | { kind: "not_found"; candidates: CachedContact[] }
  | { kind: "ambiguous"; matches: CachedContact[] }
  | { kind: "invalid"; reason: string };

const SELF_ALIASES = new Set(["me", "myself", "self", "my account"]);

// A "phone number" input is digits plus common formatting characters only,
// with enough digits to plausibly be an international number. Anything with
// a letter in it is a name — so contacts like "5 Alpha" resolve by name.
const PHONE_SHAPE = /^\+?[\d\s\-().]+$/;
const MIN_PHONE_DIGITS = 7;

export function resolveRecipient(input: string, contacts: CachedContact[]): Resolution {
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: "invalid", reason: "recipient is empty" };
  }

  if (SELF_ALIASES.has(trimmed.toLowerCase())) {
    return { kind: "self" };
  }

  if (PHONE_SHAPE.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length >= MIN_PHONE_DIGITS) {
      return { kind: "number", jid: `${digits}@s.whatsapp.net` };
    }
    // Too short to be a real number — fall through to name lookup so a
    // digits-only nickname still gets the not_found/candidates treatment.
  }

  const needle = trimmed.toLowerCase();
  const exactMatches = contacts.filter((c) => c.name.trim().toLowerCase() === needle);

  if (exactMatches.length > 1) {
    return { kind: "ambiguous", matches: exactMatches };
  }
  if (exactMatches.length === 1) {
    // A single exact match can still be the wrong pick if another saved
    // contact's name contains the same text (e.g. "Khaled" exactly matches
    // one contact, but "B.Khaled" — the one actually meant — also contains
    // "khaled"). Refuse to guess between them; surface every candidate.
    const looseMatches = contacts.filter((c) => c.name.trim().toLowerCase().includes(needle));
    if (looseMatches.length > 1) {
      return { kind: "ambiguous", matches: looseMatches };
    }
    return { kind: "resolved", jid: exactMatches[0].jid, name: exactMatches[0].name };
  }
  return { kind: "not_found", candidates: searchContacts(trimmed, contacts, 5) };
}

// ─── LID de-duplication ──────────────────────────────────────────────────────
//
// WhatsApp gives every person two identifiers: their phone number JID
// ("<digits>@s.whatsapp.net", the "PN") and a privacy-preserving "LID"
// ("<digits>@lid"). Baileys' contact events can arrive under EITHER — its
// Contact.id is documented as "ID either in lid or jid format". Storing each id
// verbatim meant one human landed in the cache twice, under two JIDs, with the
// same display name — which made resolveRecipient see two exact matches and
// refuse to send ("ambiguous"). The canonical, sendable identity is the phone
// JID, so we collapse everything onto that.
//
// Safety rule preserved: we only ever merge entries that WhatsApp itself links
// (via phoneNumber/lid fields or its lid→pn map). We NEVER merge by name — so
// two genuinely different people who happen to share a name stay two entries
// and the ambiguity guard still protects against wrong-recipient sends.

/** Minimal shape of a Baileys contact record we read for canonicalization. */
export interface RawContact {
  id: string;
  lid?: string;
  phoneNumber?: string;
}

/**
 * Normalize a phone number (bare digits or a JID) to a "<digits>@s.whatsapp.net"
 * JID. Baileys' lid→pn store returns device-suffixed JIDs like
 * "15555550123:0@s.whatsapp.net"; the ":0" must be dropped before stripping
 * non-digits, or it collapses into a bogus trailing digit and the entry stops
 * matching the real contact (the LID de-dup silently fails).
 */
export function normalizePhoneJid(pnOrJid: string): string {
  const user = pnOrJid.split("@")[0].split(":")[0];
  const digits = user.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * The canonical cache key for a contact: its phone JID whenever we can
 * determine one, otherwise the id as-is (a lid-only contact we keep — it is
 * still sendable via its LID). `lidToPn` maps a "@lid" JID to its phone JID.
 */
export function canonicalJid(c: RawContact, lidToPn: Map<string, string>): string {
  if (c.phoneNumber) return normalizePhoneJid(c.phoneNumber);
  if (c.id.endsWith("@s.whatsapp.net")) return c.id;
  if (c.id.endsWith("@lid")) {
    const pn = lidToPn.get(c.id);
    if (pn) return pn;
  }
  return c.id;
}

/** A lid↔pn pair, but only when WhatsApp hands us both sides on one record. */
export function lidMappingFrom(c: RawContact): { lid: string; pn: string } | null {
  if (c.lid && c.phoneNumber) {
    return { lid: c.lid, pn: normalizePhoneJid(c.phoneNumber) };
  }
  return null;
}

/**
 * Rewrite a name-keyed contact cache so that every "@lid" entry whose phone
 * number we now know collapses onto the phone JID, dropping the duplicate.
 * When a phone entry already exists, its (user-saved) name wins. Entries with
 * no known mapping are left untouched.
 */
export function reconcileLidEntries(
  contacts: Map<string, string>,
  lidToPn: Map<string, string>
): Map<string, string> {
  const out = new Map(contacts);
  for (const [jid, name] of contacts) {
    if (!jid.endsWith("@lid")) continue;
    const pn = lidToPn.get(jid);
    if (!pn) continue;
    out.delete(jid);
    if (!out.has(pn)) out.set(pn, name);
  }
  return out;
}

export function searchContacts(
  query: string,
  contacts: CachedContact[],
  limit = 10
): CachedContact[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return contacts.filter((c) => c.name.toLowerCase().includes(needle)).slice(0, limit);
}
