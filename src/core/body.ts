/**
 * @fileoverview Lazy body parsing for production performance.
 *
 * Body parsing is deferred until actually needed.
 * Uses Bun-native parsers:
 * - req.json()
 * - req.text()
 * - req.formData()
 * - req.arrayBuffer()
 */

export class BodyParseError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "BodyParseError";
  }
}

export interface LazyBodyOptions {
  maxJsonBytes?: number;
  maxTextBytes?: number;
  maxFormBytes?: number;
  maxFileBytes?: number;
}

type BodyKind =
  | "none"
  | "json"
  | "text"
  | "formData"
  | "arrayBuffer"
  | "blob";

export interface LazyBody {
  (): Promise<unknown>;

  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  form(): Promise<Record<string, string>>;
  multipart(): Promise<Record<string, unknown>>;
  formData(): Promise<FormData>;

  file(name?: string): Promise<File | null>;
  files(name?: string): Promise<File[]>;

  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;

  /**
   * Returns the raw request stream if the body has not been consumed.
   * Useful for proxying or streaming uploads downstream.
   */
  stream(): ReadableStream<Uint8Array> | null;

  readonly consumed: boolean;
  readonly parsed: unknown;
}

const DEFAULT_LIMITS = {
  maxJsonBytes: 2 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxFormBytes: 2 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
};

function formDataToRecord(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of fd) {
    if (typeof value === "string") {
      out[key] = value;
    } else {
      // For files, expose filename in form record.
      out[key] = value.name;
    }
  }

  return out;
}

function formDataToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of fd) {
    const existing = out[key];

    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }

  return out;
}

export function createLazyBody(
  req: Request,
  opts: LazyBodyOptions = {}
): LazyBody {
  const limits = {
    maxJsonBytes: opts.maxJsonBytes ?? DEFAULT_LIMITS.maxJsonBytes,
    maxTextBytes: opts.maxTextBytes ?? DEFAULT_LIMITS.maxTextBytes,
    maxFormBytes: opts.maxFormBytes ?? DEFAULT_LIMITS.maxFormBytes,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
  };

  let kind: BodyKind = "none";
  let value: unknown;

  let pending: Promise<unknown> | null = null;
  let pendingKind: BodyKind | null = null;

  function assertSize(max?: number): void {
    if (!max) return;

    const len = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(len) && len > max) {
      throw new BodyParseError("Payload too large", 413);
    }
  }

  function convert<T>(target: BodyKind): T {
    if (kind === target) return value as T;

    if (kind === "json") {
      const text = JSON.stringify(value);

      if (target === "text") return text as T;
      if (target === "arrayBuffer") {
        return new TextEncoder().encode(text).buffer as T;
      }
      if (target === "blob") {
        return new Blob([text], { type: "application/json" }) as T;
      }
    }

    if (kind === "text") {
      const text = value as string;

      if (target === "json") return JSON.parse(text) as T;
      if (target === "arrayBuffer") {
        return new TextEncoder().encode(text).buffer as T;
      }
      if (target === "blob") return new Blob([text]) as T;

      if (target === "formData") {
        const fd = new FormData();
        new URLSearchParams(text).forEach((v, k) => fd.append(k, v));
        return fd as T;
      }
    }

    if (kind === "arrayBuffer") {
      const buf = value as ArrayBuffer;
      const text = new TextDecoder().decode(buf);

      if (target === "text") return text as T;
      if (target === "json") return JSON.parse(text) as T;
      if (target === "blob") return new Blob([buf]) as T;
    }

    if (kind === "formData") {
      const fd = value as FormData;

      if (target === "text") {
        const params = new URLSearchParams();
        for (const [k, v] of fd) {
          if (typeof v === "string") params.append(k, v);
        }
        return params.toString() as T;
      }
    }

    throw new BodyParseError(
      `Body already consumed as "${kind}"; cannot parse as "${target}".`,
      409
    );
  }

  async function use<T>(
    target: BodyKind,
    parser: () => Promise<T>,
    max?: number
  ): Promise<T> {
    if (kind === target) return value as T;
    if (kind !== "none") return convert<T>(target);

    if (pending) {
      if (pendingKind === target) return pending as Promise<T>;

      throw new BodyParseError(
        `Body parse already in progress as "${pendingKind}".`,
        409
      );
    }

    assertSize(max);

    pendingKind = target;

    pending = parser()
      .then((v) => {
        kind = target;
        value = v;
        pending = null;
        pendingKind = null;
        return v;
      })
      .catch((err) => {
        pending = null;
        pendingKind = null;
        throw err;
      });

    return pending as Promise<T>;
  }

  function assertFileSize(file: File): void {
    if (limits.maxFileBytes && file.size > limits.maxFileBytes) {
      throw new BodyParseError("File too large", 413);
    }
  }

  const fn = async (): Promise<unknown> => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return undefined;
    }

    const ct = (req.headers.get("content-type") || "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();

    if (!ct) return undefined;

    if (ct.includes("json")) return fn.json();
    if (ct.includes("x-www-form-urlencoded")) return fn.form();
    if (ct.includes("multipart/form-data")) return fn.multipart();
    if (ct.startsWith("text/")) return fn.text();

    return fn.arrayBuffer();
  };

  const body = fn as unknown as LazyBody;

  body.json = <T = unknown>() =>
    use<T>(
      "json",
      async () => {
        try {
          return await req.json();
        } catch {
          throw new BodyParseError("Invalid JSON body", 400);
        }
      },
      limits.maxJsonBytes
    );

  body.text = () =>
    use<string>(
      "text",
      async () => {
        try {
          return await req.text();
        } catch {
          throw new BodyParseError("Invalid text body", 400);
        }
      },
      limits.maxTextBytes
    );

  body.arrayBuffer = () =>
    use<ArrayBuffer>(
      "arrayBuffer",
      async () => {
        try {
          return await req.arrayBuffer();
        } catch {
          throw new BodyParseError("Invalid binary body", 400);
        }
      },
      limits.maxTextBytes
    );

  body.blob = () =>
    use<Blob>(
      "blob",
      async () => {
        try {
          return await req.blob();
        } catch {
          throw new BodyParseError("Invalid blob body", 400);
        }
      },
      limits.maxTextBytes
    );

  body.formData = () =>
    use<FormData>(
      "formData",
      async () => {
        try {
          return await req.formData();
        } catch {
          throw new BodyParseError("Invalid form/multipart body", 400);
        }
      },
      limits.maxFormBytes
    );

  body.form = async () => {
    const fd = await body.formData();
    return formDataToRecord(fd);
  };

  body.multipart = async () => {
    const fd = await body.formData();
    return formDataToObject(fd);
  };

  body.file = async (name?: string) => {
    const fd = await body.formData();

    if (name) {
      const value = fd.get(name);
      if (value instanceof File) {
        assertFileSize(value);
        return value;
      }
      return null;
    }

    for (const value of fd.values()) {
      if (value instanceof File) {
        assertFileSize(value);
        return value;
      }
    }

    return null;
  };

  body.files = async (name?: string) => {
    const fd = await body.formData();
    const files: File[] = [];

    if (name) {
      for (const value of fd.getAll(name)) {
        if (value instanceof File) {
          assertFileSize(value);
          files.push(value);
        }
      }
      return files;
    }

    for (const value of fd.values()) {
      if (value instanceof File) {
        assertFileSize(value);
        files.push(value);
      }
    }

    return files;
  };

  body.stream = () => {
    if (kind !== "none") return null;
    return req.body;
  };

  Object.defineProperty(body, "consumed", {
    get: () => kind !== "none",
  });

  Object.defineProperty(body, "parsed", {
    get: () => value,
  });

  return body;
}

// ---------------------------------------------------------------------------
// Backward compatibility helpers
// ---------------------------------------------------------------------------

export interface BodyParser {
  readonly contentTypes: readonly string[];
  parse(req: Request): Promise<unknown>;
}

export const jsonParser: BodyParser = {
  contentTypes: ["application/json"],
  async parse(req) {
    return createLazyBody(req).json();
  },
};

export const formUrlEncodedParser: BodyParser = {
  contentTypes: ["application/x-www-form-urlencoded"],
  async parse(req) {
    return createLazyBody(req).form();
  },
};

export const multipartParser: BodyParser = {
  contentTypes: ["multipart/form-data"],
  async parse(req) {
    return createLazyBody(req).multipart();
  },
};

export const defaultParsers: readonly BodyParser[] = [
  jsonParser,
  formUrlEncodedParser,
  multipartParser,
];

export async function parseBody(
  req: Request,
  _parsers: readonly BodyParser[] = defaultParsers
): Promise<unknown> {
  return createLazyBody(req)();
}

export function needsBodyParse(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}