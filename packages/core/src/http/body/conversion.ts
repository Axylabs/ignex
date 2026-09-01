/**
 * @fileoverview Cross-kind body conversion (json ↔ text ↔ arrayBuffer ↔ blob
 * ↔ formData). A pure function over the parsed state — no request or closure
 * state — so it can be unit-tested and reasoned about in isolation. Throws
 * `BodyParseError` (409) when the current kind cannot be converted to the
 * requested target.
 */

import { encoder } from "../encoder";
import { BodyParseError } from "./errors";
import { forEachFormDataEntry } from "./form-data";
import type { BodyKind, BodyState } from "./types";

const fromJson = (value: unknown, target: BodyKind): unknown => {
  const text = JSON.stringify(value);
  if (target === "text") return text;
  if (target === "arrayBuffer") {
    return encoder.encode(text).buffer;
  }
  if (target === "blob") {
    return new Blob([text], { type: "application/json" });
  }
  return undefined;
};

const fromText = (value: unknown, target: BodyKind): unknown => {
  const text = value as string;
  if (target === "json") return JSON.parse(text);
  if (target === "arrayBuffer") {
    return encoder.encode(text).buffer;
  }
  if (target === "blob") return new Blob([text]);
  if (target === "formData") {
    const fd = new FormData();
    new URLSearchParams(text).forEach((v, k) => {
      fd.append(k, v);
    });
    return fd;
  }
  return undefined;
};

const fromArrayBuffer = (value: unknown, target: BodyKind): unknown => {
  const buf = value as ArrayBuffer;
  const text = new TextDecoder().decode(buf);
  if (target === "text") return text;
  if (target === "json") return JSON.parse(text);
  if (target === "blob") return new Blob([buf]);
  return undefined;
};

const fromFormData = (value: unknown, target: BodyKind): unknown => {
  const fd = value as FormData;
  if (target === "text") {
    const params = new URLSearchParams();
    forEachFormDataEntry(fd, (v, k) => {
      if (typeof v === "string") {
        params.append(k, v);
      }
    });
    return params.toString();
  }
  return undefined;
};

/** Dispatch to the per-kind converter for the current parse kind. */
function tryConvert(kind: BodyKind, value: unknown, target: BodyKind): unknown {
  if (kind === "json") return fromJson(value, target);
  if (kind === "text") return fromText(value, target);
  if (kind === "arrayBuffer") return fromArrayBuffer(value, target);
  if (kind === "formData") return fromFormData(value, target);
  return undefined;
}

/**
 * Cross-kind body conversion (json ↔ text ↔ arrayBuffer ↔ blob ↔ formData).
 * A pure function over the parsed state — no request or closure state — so it
 * can be unit-tested and reasoned about in isolation. Throws `BodyParseError`
 * (409) when the current kind cannot be converted to the requested target.
 */
export function convertBody(state: BodyState, target: BodyKind): unknown {
  const { kind, value } = state;

  if (kind === target) return value;
  const converted = tryConvert(kind, value, target);
  if (converted !== undefined) return converted;

  throw new BodyParseError(`Body already consumed as "${kind}"; cannot parse as "${target}".`, 409);
}
