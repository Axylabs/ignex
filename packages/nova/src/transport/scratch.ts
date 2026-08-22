/**
 * Reusable output scratch buffer for the zero-alloc encode path. `createScratch`
 * owns a growable `Uint8Array` and the FFI "needed-size" grow/retry convention
 * (`0` = error, `w > cap` = exact size). One instance is created per process in
 * `transport.ts` and reused for every encode — no per-call allocation.
 */
export interface Scratch {
  /** current backing buffer (may be reallocated by `grow`) */
  readonly view: Uint8Array;
  grow(needed: number): void;
  /**
   * Validate an FFI write count, growing + retrying once if the buffer was too
   * small. Returns the final write size, or throws on error/retry-failure.
   */
  neededSize(name: string, w: number, retry: () => number): number;
}

export const MIN_CAP = 512;

export function createScratch(initialCap = MIN_CAP): Scratch {
  let buf = new Uint8Array(initialCap);

  function grow(needed: number): void {
    if (buf.byteLength >= needed) return;
    buf = new Uint8Array(Math.max(buf.byteLength * 2, needed));
  }

  function neededSize(name: string, w: number, retry: () => number): number {
    if (w === 0) throw new Error(`ignex: serialize failed for event "${name}"`);
    if (w > buf.byteLength) {
      grow(w);
      const w2 = retry();
      if (w2 === 0 || w2 > buf.byteLength) {
        throw new Error(`ignex: serialize retry failed for event "${name}"`);
      }
      return w2;
    }
    return w;
  }

  return {
    get view(): Uint8Array {
      return buf;
    },
    grow,
    neededSize,
  };
}
