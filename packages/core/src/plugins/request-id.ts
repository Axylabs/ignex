/**
 * @fileoverview Opt-in request correlation with validated inbound identifiers.
 */

import type { IgnexContext } from "../http/context";
import { mutateHeaders } from "../http/headers";
import { generateRequestId } from "../http/request-id";
import type { IgnexPlugin } from "../lifecycle/plugin";

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAFE_ID = /^[\x21-\x7E]+$/;
const DEFAULT_MAX_LENGTH = 128;

/** Options for {@link requestId}. */
export interface RequestIdOptions {
  /** Header read and echoed. Default `x-request-id`. */
  header?: string;
  /** Accept a valid inbound header instead of always generating an id. Default `true`. */
  acceptIncoming?: boolean;
  /** Echo the correlated id on every response. Default `true`. */
  echo?: boolean;
  /** Replace the default monotonic, process-unique id generator. */
  generate?: () => string;
  /** Maximum accepted/generated id length. Default 128. */
  maxLength?: number;
}

const validId = (id: string, maxLength: number): boolean =>
  id.length > 0 && id.length <= maxLength && SAFE_ID.test(id);

/**
 * Correlate context state, logs, errors, and responses with one request id.
 *
 * Incoming ids are bounded to visible ASCII and `maxLength`; invalid values are
 * replaced. The plugin is opt-in and declares its context requirements for AOT
 * specialization. `echo: false` omits the response hook entirely.
 */
export const requestId = (options: RequestIdOptions = {}): IgnexPlugin => {
  const header = options.header ?? "x-request-id";
  if (!HEADER_NAME.test(header)) {
    throw new Error("requestId header must be a valid HTTP header name");
  }
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 10_000) {
    throw new Error("requestId maxLength must be an integer between 1 and 10000");
  }
  const acceptIncoming = options.acceptIncoming ?? true;
  const generate = options.generate ?? generateRequestId;

  const onRequest = (ctx: IgnexContext): IgnexContext => {
    const inbound = acceptIncoming ? ctx.headers.get(header) : null;
    const id = inbound !== null && validId(inbound, maxLength) ? inbound : generate();
    if (!validId(id, maxLength)) {
      throw new Error("requestId generator returned an invalid or oversized id");
    }
    // The mutable setter is implemented by the full context; specialized AOT
    // contexts expose a writable property. Keep direct reads and legacy state
    // consumers on the same value.
    (ctx as { requestId: string }).requestId = id;
    ctx.setState("requestId", id);
    return ctx;
  };

  return {
    name: "request-id",
    contextUsage: {
      headers: true,
      state: true,
      requestId: true,
    },
    onRequest,
    ...(options.echo === false
      ? {}
      : {
          onResponse(ctx: IgnexContext, response: Response): Response {
            return mutateHeaders(response, (headers) => headers.set(header, ctx.requestId));
          },
        }),
  };
};
