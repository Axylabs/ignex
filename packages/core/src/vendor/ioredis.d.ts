/**
 * Ambient type surface for the OPTIONAL `ioredis` dependency used by
 * `createRedisStore`. Mapped through the root tsconfig `paths`, so TypeScript
 * resolves the module even when ioredis isn't installed (the store driver is
 * opt-in — memory/sqlite/file are the defaults). Mirrors the castrum /
 * nodemailer vendor pattern.
 */
declare module "ioredis" {
  export default class Redis {
    constructor(urlOrOptions?: string | Record<string, unknown>);
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode?: "PX", ms?: number): Promise<unknown>;
    del(...keys: string[]): Promise<number>;
    pexpire(key: string, ms: number): Promise<number>;
    persist(key: string): Promise<number>;
    quit(): Promise<unknown>;
  }
}
