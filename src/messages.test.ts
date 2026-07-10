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
