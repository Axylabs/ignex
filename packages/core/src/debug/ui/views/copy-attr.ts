/**
 * @fileoverview Tiny helper for copy-on-click elements (`data-copy` handled by
 * the shell's delegated click listener).
 */

/** Spread into an `h()` props object to make the element a copy button. */
export const copyAttr = (text: string): { "data-copy": string } => ({ "data-copy": text });
