/**
 * @fileoverview Query string parser using fast-querystring.
 */

import { parse as parseQueryString } from "fast-querystring";

export const parseQuery = (
  input: string
): Record<string, string | string[]> => {
  return parseQueryString(input) as Record<string, string | string[]>;
};

export const parseQueryFromURL = (
  url: string
): Record<string, string | string[]> => {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return {};
  return parseQuery(url.slice(qIdx + 1));
};