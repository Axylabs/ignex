/**
 * @fileoverview `createRpcKit` — framework-owned authenticated RPC-over-
 * realtime registry + dispatcher.
 *
 * Owns everything the transport needs so apps stop re-implementing the
 * protocol per product: method registration with compiled native validation,
 * the reply envelope (`rpc.response`), error→status mapping, and a machine-
 * readable `.ignex/rpc-manifest.json` artifact that `ignex sdk --platform
 * realtime` consumes to emit a typed client — so frontend call sites are
 * checked against the same schemas the server validates with.
 *
 * The kit is dependency-light by design: native compilation and TypeBox
 * fallback checks are injected by the app (which already depends on those
 * packages), keeping this module pure orchestration.
 *
 * Wire contract (`rpc.request` → `rpc.response`, user-targeted):
 * - request: `{ id, method, payload }` where payload is JSON-encoded args;
 * - success response: `{ id, ok: true, data: <JSON result>, error: "" }`;
 * - failure response: `{ id, ok: false, data: "", error: <JSON> }` where the
 *   error JSON is `{ message, status }` — status mirrors HTTP semantics
 *   (400 validation, 401 auth, 404 unknown method, 5xx handler failure).
 *
 * ```ts
 * const kit = createRpcKit({
 *   manifestPath: join(import.meta.dir, "../../.ignex/rpc-manifest.json"),
 *   compileValidator: (json) => createSchemaValidator(json),
 *   fallbackCheck: (schema, value) => Value.Check(schema, value),
 * });
 * export const rpc = kit.define;
 * // plugin init():
 * await kit.registerDispatcher();
 * ```
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Per-call context handed to handlers (the socket identity is the credential). */
export interface RpcKitContext {
  /** Authenticated user id (from the ws-token handshake / client record). */
  userId: string;
}

/** Schema shape produced by TypeBox (`Type.Object(...)`). Structural only. */
export type RpcKitSchema = object;

/** A registered RPC method: payload schema + handler over shared module logic. */
export interface RpcKitMethod {
  /** TypeBox schema the payload must satisfy (also emitted to the manifest). */
  schema: RpcKitSchema;
  /** Handler receiving the validated payload. */
  handler: (payload: unknown, ctx: RpcKitContext) => Promise<unknown> | unknown;
}

/** Compiled validator over the RAW JSON payload string (native fast path). */
export interface RpcKitCompiledValidator {
  validate(raw: string): boolean;
}

/** Injected validators (the app supplies @ignex/native + typebox bindings). */
export interface RpcKitOptions {
  /**
   * Where the SDK-facing manifest is written. Omit to disable manifest
   * emission (e.g. tests). Written atomically after registrations settle.
   */
  manifestPath?: string;
  /**
   * Compile a schema's JSON into a raw-string validator (native addon path).
   * Called once per method at registration; a thrown error or null result
   * must never break registration.
   */
  compileValidator?: (schemaJson: string) => RpcKitCompiledValidator | null;
  /**
   * Interpreted fallback check used when `compileValidator` is unavailable.
   * Return false to reject the payload with status 400. When neither this
   * nor `compileValidator` is provided, payloads are accepted unvalidated.
   */
  fallbackCheck?: (schema: RpcKitSchema, value: unknown) => boolean;
  /** Human-readable first-validation-error text for 400 replies (optional). */
  describeError?: (schema: RpcKitSchema, value: unknown) => string;
}

/** A compiled registry entry. */
interface CompiledMethod extends RpcKitMethod {
  native: RpcKitCompiledValidator | null;
}

/** The wire reply envelope (`rpc.response` payload). */
interface ReplyEnvelope {
  id: string;
  ok: boolean;
  data: string;
  error: string;
}

const MANIFEST_VERSION = 1;

/** Manifest write debounce (registrations usually arrive in bursts). */
const MANIFEST_DEBOUNCE_MS = 20;

/** The SDK-facing manifest document (deterministic: sorted method names). */
export interface RpcManifestDoc {
  version: number;
  methods: Record<string, object>;
}

/**
 * Map any handler error to the envelope's `{ message, status }` pair.
 * Errors carrying a numeric `status` (HTTPError & friends) keep it.
 */
const errorToEnvelope = (err: unknown): { message: string; status: number } => {
  const e = err as { status?: unknown; message?: unknown; error?: unknown };
  const message =
    typeof e.message === "string"
      ? e.message
      : typeof e.error === "string"
        ? e.error
        : "RPC handler failed";
  const status = typeof e.status === "number" ? e.status : 500;
  return { message, status };
};

/** Atomic JSON file write (tmp + rename) under an ensured directory. */
const writeJsonAtomic = (path: string, doc: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, doc);
  renameSync(tmp, path);
};

/**
 * Create an RPC kit (registry + dispatcher + manifest emitter). One kit per
 * app; registration is idempotent per method name (last definition wins),
 * matching hot-reload semantics. `registerDispatcher` binds exactly once.
 */
export const createRpcKit = (
  options: RpcKitOptions,
): {
  /** Register (or replace) an authenticated RPC method. */
  define: (method: string, def: RpcKitMethod) => void;
  /** True when the method exists (tooling/tests). */
  has: (method: string) => boolean;
  /** Registered method names, sorted (tooling/tests). */
  methods: () => string[];
  /** Bind the dispatcher onto the nova events hub (after novaPlugin init). */
  registerDispatcher: () => Promise<void>;
  /** The manifest document exactly as it would be written to disk. */
  manifest: () => RpcManifestDoc;
  /** Flush the pending manifest write immediately (tests/shutdown). */
  flushManifest: () => void;
} => {
  const registry = new Map<string, CompiledMethod>();
  let dispatcherBound = false;
  let manifestTimer: ReturnType<typeof setTimeout> | null = null;
  let warned = false;

  const warnOnce = (err: unknown): void => {
    if (warned) return;
    warned = true;
    console.warn("[rpc-kit] manifest write failed:", err instanceof Error ? err.message : err);
  };

  const writeManifestNow = (): void => {
    if (options.manifestPath === undefined) return;
    try {
      writeJsonAtomic(options.manifestPath, `${JSON.stringify(kit.manifest(), null, 2)}\n`);
    } catch (err) {
      warnOnce(err);
    }
  };

  const scheduleManifestWrite = (): void => {
    if (options.manifestPath === undefined) return;
    if (manifestTimer !== null) clearTimeout(manifestTimer);
    manifestTimer = setTimeout(() => {
      manifestTimer = null;
      writeManifestNow();
    }, MANIFEST_DEBOUNCE_MS);
    // Never hold the process open for a debounced artifact write.
    (manifestTimer as unknown as { unref?: () => void }).unref?.();
  };

  const kit = {
    define(method: string, def: RpcKitMethod): void {
      let native: RpcKitCompiledValidator | null = null;
      if (options.compileValidator !== undefined) {
        try {
          native = options.compileValidator(JSON.stringify(def.schema));
        } catch {
          native = null; // compile failure must never break registration
        }
      }
      registry.set(method, { ...def, native });
      scheduleManifestWrite();
    },

    has(method: string): boolean {
      return registry.has(method);
    },

    methods(): string[] {
      return [...registry.keys()].sort();
    },

    manifest(): RpcManifestDoc {
      const methods: Record<string, object> = {};
      for (const name of [...registry.keys()].sort()) {
        methods[name] = registry.get(name)?.schema ?? {};
      }
      return { version: MANIFEST_VERSION, methods };
    },

    flushManifest(): void {
      if (manifestTimer !== null) {
        clearTimeout(manifestTimer);
        manifestTimer = null;
      }
      writeManifestNow();
    },

    async registerDispatcher(): Promise<void> {
      if (dispatcherBound) return;
      dispatcherBound = true;
      // Loose structural view of nova's strongly-generic `on` — the kit only
      // ever binds the fixed "rpc.request" channel.
      const events = (await import("@ignex/nova/events")) as unknown as {
        on: (name: string, handler: (payload: unknown, ctx: unknown) => Promise<void>) => unknown;
      };
      events.on("rpc.request", async (rawPayload: unknown, hubCtx: unknown) => {
        const req = rawPayload as { id?: unknown; method?: unknown; payload?: unknown };
        const ctx = hubCtx as unknown as {
          client?: { userId?: string };
          emitToUser: (userId: string, name: string, payload: unknown) => void;
        };
        const userId = ctx.client?.userId;
        const reply = (envelope: ReplyEnvelope): void => {
          if (!userId) return;
          ctx.emitToUser(userId, "rpc.response", envelope);
        };

        if (!userId || !req || typeof req.id !== "string" || typeof req.method !== "string") {
          // Unauthenticated or malformed — nothing to correlate reliably.
          return;
        }
        const def = registry.get(req.method) as CompiledMethod | undefined;
        if (!def) {
          reply({
            id: req.id,
            ok: false,
            data: "",
            error: JSON.stringify({ message: `Unknown RPC method: ${req.method}`, status: 404 }),
          });
          return;
        }

        let args: unknown;
        const rawPayloadString = typeof req.payload === "string" ? req.payload : "{}";
        try {
          args = JSON.parse(rawPayloadString);
        } catch {
          reply({
            id: req.id,
            ok: false,
            data: "",
            error: JSON.stringify({ message: "Invalid JSON payload", status: 400 }),
          });
          return;
        }

        // Native compiled validator over the RAW payload when available;
        // injected interpreted fallback otherwise; neither → accept.
        const checked =
          def.native !== null
            ? def.native.validate(rawPayloadString)
            : (options.fallbackCheck?.(def.schema, args) ?? true);
        if (!checked) {
          const detail = options.describeError?.(def.schema, args) ?? "Invalid payload";
          reply({
            id: req.id,
            ok: false,
            data: "",
            error: JSON.stringify({ message: detail, status: 400 }),
          });
          return;
        }

        try {
          const result = await def.handler(args, { userId });
          reply({ id: req.id, ok: true, data: JSON.stringify(result ?? null), error: "" });
        } catch (err) {
          const { message, status } = errorToEnvelope(err);
          reply({
            id: req.id,
            ok: false,
            data: "",
            error: JSON.stringify({ message, status }),
          });
        }
      });
    },
  };

  return kit;
};
