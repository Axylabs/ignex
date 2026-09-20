/**
 * @fileoverview Docs panel data — list + single-doc reads confined to the KT
 * docs inventory (same roots as the KT page). Security: `readDoc` only ever
 * reads paths present in the inventory produced by `scanDocsInventory` (real
 * `.md` files under the allowed roots, no symlink following), so traversal —
 * absolute paths, `..`, unlisted files — can only yield `null`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { listAllDocs } from "./kt";
import { renderMarkdownHtml } from "./markdown";
import type { DocPayload, KnowledgeDoc } from "./types";

/** The Docs panel inventory (`GET /api/docs`). */
export const listDocs = (root: string, docsPaths: readonly string[]): Promise<KnowledgeDoc[]> =>
  listAllDocs(root, docsPaths);

/** Read one doc — `null` unless it is an inventory entry (never reads outside). */
export const readDoc = async (
  root: string,
  docsPaths: readonly string[],
  requestedPath: string,
): Promise<DocPayload | null> => {
  const docs = await listAllDocs(root, docsPaths);
  const entry = docs.find((d) => d.path === requestedPath);
  if (entry === undefined) return null;
  // `entry.path` is root-relative (or absolute for outside-root docs); resolve
  // against the scan root so the file is read at the scanned location, never
  // against the process cwd.
  const markdown = await readFile(resolve(root, entry.path), "utf8").catch(() => null);
  if (markdown === null) return null;
  return {
    path: entry.path,
    title: entry.title,
    markdown,
    html: renderMarkdownHtml(markdown),
  };
};
