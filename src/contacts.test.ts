import { describe, it, expect } from "vitest";
import {
  resolveRecipient,
  searchContacts,
  canonicalJid,
  lidMappingFrom,
  reconcileLidEntries,
  type CachedContact,
} from "./contacts.js";

// Synthetic contact list (fictional 555-prefixed numbers, made-up names — this
// is a public repo, never real contacts) exercising the cases that caused a
// real-world wrong-recipient send: multiple people sharing a name fragment.
const contacts: CachedContact[] = [
  { jid: "555000000001@s.whatsapp.net", name: "Alice" },
  { jid: "555000000002@s.whatsapp.net", name: "Bravo" },
  { jid: "555000000003@s.whatsapp.net", name: "Coach Sam The Great" },
  { jid: "555000000004@s.whatsapp.net", name: "T. Sam Baker" },
  { jid: "555000000005@s.whatsapp.net", name: "Sam" },
  { jid: "555000000006@s.whatsapp.net", name: "sam" },
  { jid: "555000000007@s.whatsapp.net", name: "5 Alpha" },
  { jid: "555000000010@s.whatsapp.net", name: "Gray" },
  { jid: "555000000011@s.whatsapp.net", name: "B.Gray" },
];

describe("resolveRecipient — names", () => {
  it("resolves a unique exact name match", () => {
    const r = resolveRecipient("Alice", contacts);
    expect(r).toEqual({
      kind: "resolved",
      jid: "555000000001@s.whatsapp.net",
      name: "Alice",
    });
  });

  it("matches case-insensitively", () => {
    const r = resolveRecipient("aLICE", contacts);
    expect(r.kind).toBe("resolved");
  });

  it("tolerates surrounding whitespace", () => {
    const r = resolveRecipient("  Bravo  ", contacts);
    expect(r).toMatchObject({ kind: "resolved", name: "Bravo" });
  });

  it("REFUSES when several contacts match exactly (ambiguous)", () => {
    const r = resolveRecipient("Sam", contacts);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.matches).toHaveLength(2); // "Sam" and "sam"
    }
  });

  it("returns not_found with substring candidates instead of guessing", () => {
    const r = resolveRecipient("Baker", contacts);
    expect(r.kind).toBe("not_found");
    if (r.kind === "not_found") {
      expect(r.candidates.map((c) => c.name)).toContain("T. Sam Baker");
    }
  });

  it("treats names containing digits as names, not numbers", () => {
    const r = resolveRecipient("5 Alpha", contacts);
    expect(r).toMatchObject({ kind: "resolved", name: "5 Alpha" });
  });

  it("REFUSES a lone exact match when another contact's name contains it, instead of guessing", () => {
    // Regression test for a real wrong-recipient send: typing "Khaled" found
    // an unrelated contact named exactly "Khaled" and sent to them, even
    // though "B.Khaled" (the intended contact) also contains that text.
    const r = resolveRecipient("Gray", contacts);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.matches.map((c) => c.name).sort()).toEqual(["B.Gray", "Gray"]);
    }
  });
});

describe("resolveRecipient — self aliases", () => {
  it.each(["me", "Myself", "SELF", "my account"])('"%s" resolves to self', (alias) => {
    expect(resolveRecipient(alias, contacts).kind).toBe("self");
  });
});

describe("resolveRecipient — phone numbers", () => {
  it("normalizes a formatted international number to a JID", () => {
    const r = resolveRecipient("+555 00-000 0001", contacts);
    expect(r).toEqual({ kind: "number", jid: "555000000001@s.whatsapp.net" });
  });

  it("accepts bare digit strings of plausible length", () => {
    const r = resolveRecipient("555000000009", contacts);
    expect(r).toEqual({ kind: "number", jid: "555000000009@s.whatsapp.net" });
  });

  it("does NOT treat short digit strings as phone numbers", () => {
    const r = resolveRecipient("12345", contacts);
    expect(r.kind).toBe("not_found");
  });
});

describe("resolveRecipient — invalid input", () => {
  it("rejects empty and whitespace-only input", () => {
    expect(resolveRecipient("", contacts).kind).toBe("invalid");
    expect(resolveRecipient("   ", contacts).kind).toBe("invalid");
  });
});

// ─── LID de-duplication ──────────────────────────────────────────────────────
// WhatsApp exposes each person under BOTH a phone JID (@s.whatsapp.net) and a
// privacy "LID" (@lid). Baileys' Contact.id can be either. Keying the cache on
// the raw id produced two entries per person with the same name, which tripped
// the "ambiguous, refusing to guess" guard. These functions collapse a person
// onto their canonical phone JID without ever merging by name (so genuinely
// distinct same-name contacts stay distinct).

// NOTE: all JIDs/numbers/names below are synthetic placeholders (555-prefixed,
// fictional). This is a public repo — never put real contact data in tests.
describe("canonicalJid", () => {
  const empty = new Map<string, string>();

  it("uses phoneNumber as the canonical JID when present", () => {
    expect(canonicalJid({ id: "100000000000001@lid", phoneNumber: "555000000001" }, empty)).toBe(
      "555000000001@s.whatsapp.net"
    );
  });

  it("normalizes a phoneNumber already in JID form", () => {
    expect(
      canonicalJid({ id: "x@lid", phoneNumber: "555000000001@s.whatsapp.net" }, empty)
    ).toBe("555000000001@s.whatsapp.net");
  });

  it("keeps an @s.whatsapp.net id as-is", () => {
    expect(canonicalJid({ id: "555000000001@s.whatsapp.net" }, empty)).toBe(
      "555000000001@s.whatsapp.net"
    );
  });

  it("maps a bare @lid id through the lid→pn table when known", () => {
    const map = new Map([["100000000000001@lid", "555000000001@s.whatsapp.net"]]);
    expect(canonicalJid({ id: "100000000000001@lid" }, map)).toBe("555000000001@s.whatsapp.net");
  });

  it("keeps a lid-only contact under its LID when no mapping is known", () => {
    expect(canonicalJid({ id: "100000000000002@lid" }, empty)).toBe("100000000000002@lid");
  });

  it("strips the device suffix from a phoneNumber (Baileys returns '<num>:0@...')", () => {
    // getPNForLID hands back JIDs like "555000000001:0@s.whatsapp.net"; the
    // ":0" device part must be dropped, not folded into the number.
    expect(canonicalJid({ id: "x@lid", phoneNumber: "555000000001:0@s.whatsapp.net" }, empty)).toBe(
      "555000000001@s.whatsapp.net"
    );
  });
});

describe("lidMappingFrom", () => {
  it("extracts a lid↔pn pair when the record carries both", () => {
    expect(
      lidMappingFrom({ id: "100000000000001@lid", lid: "100000000000001@lid", phoneNumber: "555000000001" })
    ).toEqual({ lid: "100000000000001@lid", pn: "555000000001@s.whatsapp.net" });
  });

  it("returns null when either side is missing", () => {
    expect(lidMappingFrom({ id: "555000000001@s.whatsapp.net" })).toBeNull();
    expect(lidMappingFrom({ id: "100000000000001@lid", lid: "100000000000001@lid" })).toBeNull();
  });

  it("normalizes a device-suffixed phoneNumber in the mapping", () => {
    expect(
      lidMappingFrom({ id: "100000000000001@lid", lid: "100000000000001@lid", phoneNumber: "555000000001:0@s.whatsapp.net" })
    ).toEqual({ lid: "100000000000001@lid", pn: "555000000001@s.whatsapp.net" });
  });
});

describe("reconcileLidEntries", () => {
  it("collapses a lid duplicate onto the existing phone entry, keeping the phone name", () => {
    const cache = new Map([
      ["555000000001@s.whatsapp.net", "Alice"],
      ["100000000000001@lid", "Alice Profile"],
    ]);
    const lidToPn = new Map([["100000000000001@lid", "555000000001@s.whatsapp.net"]]);
    const out = reconcileLidEntries(cache, lidToPn);
    expect(out.get("555000000001@s.whatsapp.net")).toBe("Alice");
    expect(out.has("100000000000001@lid")).toBe(false);
    expect(out.size).toBe(1);
  });

  it("moves a lid-only contact to its phone JID once a mapping is learned", () => {
    const cache = new Map([["100000000000002@lid", "Bob"]]);
    const lidToPn = new Map([["100000000000002@lid", "555000000002@s.whatsapp.net"]]);
    const out = reconcileLidEntries(cache, lidToPn);
    expect(out.get("555000000002@s.whatsapp.net")).toBe("Bob");
    expect(out.has("100000000000002@lid")).toBe(false);
  });

  it("leaves lid entries untouched when no mapping is known", () => {
    const cache = new Map([["100000000000002@lid", "Bob"]]);
    const out = reconcileLidEntries(cache, new Map());
    expect(out.get("100000000000002@lid")).toBe("Bob");
  });

  it("preserves two genuinely distinct people who share a name", () => {
    // Different phone numbers, same display name — must stay two entries so the
    // ambiguity guard still refuses to guess (the safety-critical case).
    const cache = new Map([
      ["555000000003@s.whatsapp.net", "Sam"],
      ["555000000004@s.whatsapp.net", "Sam"],
    ]);
    const out = reconcileLidEntries(cache, new Map());
    expect(out.size).toBe(2);
  });
});

describe("searchContacts", () => {
  it("finds contacts by case-insensitive substring", () => {
    const results = searchContacts("sam", contacts);
    expect(results.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Sam", "sam", "Coach Sam The Great", "T. Sam Baker"])
    );
  });

  it("respects the result limit", () => {
    expect(searchContacts("sam", contacts, 2)).toHaveLength(2);
  });

  it("returns empty array for no matches", () => {
    expect(searchContacts("zzz-nobody", contacts)).toEqual([]);
  });
});
