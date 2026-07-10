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
