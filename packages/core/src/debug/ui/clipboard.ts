/**
 * @fileoverview Clipboard helper with legacy fallback (non-secure contexts).
 */

import { toast } from "./toast";

const fallbackCopy = (text: string, done: () => void): void => {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } catch {
    toast("copy failed");
  }
  document.body.removeChild(ta);
};

/** Copy text to the clipboard with a confirmation toast. */
export const copyText = (text: string): void => {
  const done = (): void => toast("copied to clipboard");
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).then(done, (): void => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
};
