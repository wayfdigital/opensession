/**
 * Magic-byte detection for the raster formats we are willing to hand to an
 * image decoder.
 *
 * A declared mime type (a `data:image/png` prefix) or a file extension says
 * nothing about the bytes behind it. sharp/libvips picks its loader from the
 * content, so SVG (or gzipped SVGZ) labelled `.png` would still be parsed by
 * librsvg. Callers that decode untrusted images sniff the bytes first and only
 * proceed when this returns a format. Anything that is not one of the four
 * signatures below, including text formats with a BOM or leading whitespace,
 * is rejected.
 */

export type RasterImageFormat = "png" | "jpeg" | "webp" | "gif";

/** Bytes needed to recognise every supported signature. */
export const RASTER_SNIFF_BYTES = 12;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** The raster format the bytes actually are, or undefined for anything else. */
export function sniffRasterImage(
  bytes: Uint8Array,
): RasterImageFormat | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "webp";
  return undefined;
}

const MIME: Record<RasterImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Mime type for a sniffed raster format. */
export function rasterImageMime(format: RasterImageFormat): string {
  return MIME[format];
}
