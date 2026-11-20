// Width and height from the first bytes of a PNG or JPEG, for the cover check. Hand-written,
// because core/ has no runtime dependencies. Reads headers only; never decodes pixels.

export interface ImageSize {
  format: "png" | "jpeg";
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

function png(b: Uint8Array): ImageSize | null {
  // Signature, then the IHDR chunk: length 13, "IHDR", width, height.
  if (b.length < 24) return null;
  if (u32(b, 8) !== 13 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  const width = u32(b, 16);
  const height = u32(b, 20);
  return width > 0 && height > 0 ? { format: "png", width, height } : null;
}

// Start-of-frame markers: baseline, progressive and the rest, but not DHT (C4), JPG (C8) or DAC (CC).
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    // Fill bytes before a marker.
    while (b[at] === 0xff && at + 1 < b.length && b[at + 1] === 0xff) at++;
    const marker = b[at + 1];
    at += 2;
    // Markers with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // End of image or start of scan before a frame header: no size.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (at + 2 > b.length) return null;
    const length = u16(b, at);
    if (length < 2) return null;
    if (SOF.has(marker)) {
      if (at + 7 > b.length) return null;
      const height = u16(b, at + 3);
      const width = u16(b, at + 5);
      return width > 0 && height > 0 ? { format: "jpeg", width, height } : null;
    }
    at += length;
  }
  return null;
}

/** The image's format, width and height, or null when the bytes are not a readable PNG or JPEG. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return png(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  return null;
}
