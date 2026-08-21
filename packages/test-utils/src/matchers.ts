/**
 * @fileoverview Generic Web `Response` assertion helpers shared across
 * packages (replaces the per-package `expectJson`/`expectStatus` duplicates
 * in app test helpers and scripts/smoke.ts).
 */

import { expect } from "vitest";

/** Assert a Response has the given status code (typed narrowing included). */
export const expectStatus = (res: Response, code: number): Response => {
  expect(res.status).toBe(code);
  return res;
};

/**
 * Assert a Response is `application/json` and (optionally) equals a body.
 *
 * `status` is optional: pass it to assert a non-200 JSON envelope (400/422
 * validation, 401, …) in a single call; omit it to assert JSON only.
 */
export const expectJson = async <T = unknown>(
  res: Response,
  body?: T,
  status?: number,
): Promise<T> => {
  if (status !== undefined) expectStatus(res, status);
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toContain("application/json");
  const parsed = (await res.json()) as T;
  if (body !== undefined) {
    expect(parsed).toEqual(body);
  }
  return parsed;
};

/**
 * Assert a Response is `text/*` and (optionally) equals a string.
 */
export const expectText = async (res: Response, body?: string): Promise<string> => {
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toMatch(/^text\//);
  const text = await res.text();
  if (body !== undefined) {
    expect(text).toBe(body);
  }
  return text;
};
