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

/** Assert a Response is `application/json` and (optionally) equals a body. */
export const expectJson = async <T = unknown>(res: Response, body?: T): Promise<T> => {
  expectStatus(res, 200);
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toContain("application/json");
  const parsed = (await res.json()) as T;
  if (body !== undefined) {
    expect(parsed).toEqual(body);
  }
  return parsed;
};

/** Assert a Response is `text/*` and (optionally) equals a string. */
export const expectText = async (res: Response, body?: string): Promise<string> => {
  const text = await res.text();
  if (body !== undefined) {
    expect(text).toBe(body);
  }
  return text;
};

/** Assert a Response body is empty. */
export const expectEmpty = (res: Response): Response => {
  expect(res.body).toBeNull();
  return res;
};
