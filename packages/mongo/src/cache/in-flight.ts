/**
 * In-flight request coalescing: identical concurrent operations share a single
 * Promise so the underlying (expensive) work runs once. This is the "query
 * dedup" optimization used by the CRUD read path.
 */
export class InFlight {
  private pending = new Map<string, Promise<unknown>>();

  get size(): number {
    return this.pending.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const promise = fn().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void {
    this.pending.clear();
  }
}
