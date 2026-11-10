import { describe, expect, test } from "bun:test";
import { gzipSync } from "zlib";
import { rasterImageMime, sniffRasterImage } from "./raster-sniff";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Buffer.from(text, "latin1");

describe("sniffRasterImage", () => {
  test("recognises the full PNG signature", () => {
    expect(
      sniffRasterImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe("png");
  });

  test("requires all eight PNG signature bytes", () => {
    expect(sniffRasterImage(bytes(0x89, 0x50, 0x4e, 0x47))).toBeUndefined();
    expect(
      sniffRasterImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00)),
    ).toBeUndefined();
  });

  test("recognises JPEG", () => {
    expect(sniffRasterImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(sniffRasterImage(bytes(0xff, 0xd8, 0xff))).toBe("jpeg");
    expect(sniffRasterImage(bytes(0xff, 0xd8))).toBeUndefined();
  });

  test("recognises GIF87a and GIF89a only", () => {
    expect(sniffRasterImage(ascii("GIF87a"))).toBe("gif");
    expect(sniffRasterImage(ascii("GIF89a...."))).toBe("gif");
    expect(sniffRasterImage(ascii("GIF8"))).toBeUndefined();
    expect(sniffRasterImage(ascii("GIF88a"))).toBeUndefined();
  });

  test("recognises RIFF....WEBP and no other RIFF", () => {
    expect(sniffRasterImage(ascii("RIFF\x10\x00\x00\x00WEBPVP8 "))).toBe(
      "webp",
    );
    expect(sniffRasterImage(ascii("RIFF\x10\x00\x00\x00WAVEfmt "))).toBe(
      undefined,
    );
    expect(sniffRasterImage(ascii("RIFF\x10\x00\x00\x00WEB"))).toBeUndefined();
  });

  test("rejects SVG and XML however they start", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    for (const text of [
      svg,
      `<?xml version="1.0"?>${svg}`,
      `\n  ${svg}`,
      `\t${svg}`,
      `<!DOCTYPE svg>${svg}`,
      `<!-- GIF89a -->${svg}`,
    ]) {
      expect(sniffRasterImage(Buffer.from(text))).toBeUndefined();
    }
    // UTF-8, UTF-16LE and UTF-16BE byte-order marks.
    expect(
      sniffRasterImage(Buffer.concat([bytes(0xef, 0xbb, 0xbf), ascii(svg)])),
    ).toBeUndefined();
    expect(
      sniffRasterImage(
        Buffer.concat([bytes(0xff, 0xfe), Buffer.from(svg, "utf16le")]),
      ),
    ).toBeUndefined();
    expect(
      sniffRasterImage(
        Buffer.concat([
          bytes(0xfe, 0xff),
          Buffer.from(svg, "utf16le").swap16(),
        ]),
      ),
    ).toBeUndefined();
  });

  test("rejects gzip (svgz) and other non-raster formats", () => {
    expect(
      sniffRasterImage(gzipSync(Buffer.from("<svg xmlns='x'/>"))),
    ).toBeUndefined();
    expect(sniffRasterImage(bytes(0x1f, 0x8b, 0x08, 0x00))).toBeUndefined();
    // BMP, PDF, TIFF, AVIF/HEIF.
    expect(sniffRasterImage(ascii("BM\x00\x00\x00\x00"))).toBeUndefined();
    expect(sniffRasterImage(ascii("%PDF-1.7"))).toBeUndefined();
    expect(sniffRasterImage(bytes(0x49, 0x49, 0x2a, 0x00))).toBeUndefined();
    expect(sniffRasterImage(ascii("\x00\x00\x00\x1cftypavif"))).toBeUndefined();
  });

  test("rejects empty and truncated input", () => {
    expect(sniffRasterImage(new Uint8Array())).toBeUndefined();
    expect(sniffRasterImage(bytes(0x89))).toBeUndefined();
    expect(sniffRasterImage(ascii("RIFF"))).toBeUndefined();
  });

  test("maps formats to mime types", () => {
    expect(rasterImageMime("png")).toBe("image/png");
    expect(rasterImageMime("jpeg")).toBe("image/jpeg");
    expect(rasterImageMime("webp")).toBe("image/webp");
    expect(rasterImageMime("gif")).toBe("image/gif");
  });
});
