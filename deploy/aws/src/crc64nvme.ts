/**
 * CRC-64/NVME, the checksum S3 calls CRC64NVME (reflected polynomial 0x9a6c9329ac4bc9b5,
 * initial value and final XOR all ones). Returned as S3 shows it: base64 of the 8 bytes, high
 * byte first. Used by the smoke test (and a client would compute the same over the whole file).
 * Two 32-bit halves instead of BigInt, so a few MiB takes well under a second.
 */
const TABLE_HI = new Uint32Array(256);
const TABLE_LO = new Uint32Array(256);
const POLY_HI = 0x9a6c9329;
const POLY_LO = 0xac4bc9b5;
for (let n = 0; n < 256; n++) {
  let hi = 0;
  let lo = n;
  for (let k = 0; k < 8; k++) {
    const carry = lo & 1;
    lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
    hi = hi >>> 1;
    if (carry) {
      hi = (hi ^ POLY_HI) >>> 0;
      lo = (lo ^ POLY_LO) >>> 0;
    }
  }
  TABLE_HI[n] = hi;
  TABLE_LO[n] = lo;
}

export class Crc64Nvme {
  private hi = 0xffffffff;
  private lo = 0xffffffff;

  update(bytes: Uint8Array): this {
    let hi = this.hi;
    let lo = this.lo;
    for (let i = 0; i < bytes.length; i++) {
      const k = (lo ^ bytes[i]) & 0xff;
      lo = (((lo >>> 8) | (hi << 24)) ^ TABLE_LO[k]) >>> 0;
      hi = ((hi >>> 8) ^ TABLE_HI[k]) >>> 0;
    }
    this.hi = hi;
    this.lo = lo;
    return this;
  }

  /** The 8 bytes, high byte first. */
  digest(): Uint8Array {
    const out = new Uint8Array(8);
    const view = new DataView(out.buffer);
    view.setUint32(0, (this.hi ^ 0xffffffff) >>> 0);
    view.setUint32(4, (this.lo ^ 0xffffffff) >>> 0);
    return out;
  }

  base64(): string {
    return Buffer.from(this.digest()).toString("base64");
  }
}

export function crc64nvme(bytes: Uint8Array): string {
  return new Crc64Nvme().update(bytes).base64();
}
