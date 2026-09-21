/**
 * @fileoverview Advisory header-bomb tally (`maxHeaderBytes`).
 *
 * Bun enforces its own header limits at the socket, so this is defense-in-
 * depth for servers that receive headers already materialized by a reverse
 * proxy or CDN layer: a pure byte tally plus an opt-in HTTP 431 gate.
 */

/** on-the-wire framing overhead per header pair: `<name>: <value>\r\n`. */
const NAME_VALUE_SEP_BYTES = 2; // ": "
const CRLF_BYTES = 2;

/**
 * Total on-the-wire header bytes for `headers`: each pair contributes
 * `name.length + 2 + value.length + 2` (the `: ` separator and CRLF).
 * Iterates the `Headers` record once; no mutation, no allocation beyond the
 * running total.
 *
 * @param headers - The request headers.
 * @returns The framed byte count, or 0 for an empty header set.
 */
export const totalHeaderBytes = (headers: Headers): number => {
  let total = 0;
  headers.forEach((value, name) => {
    total += name.length + NAME_VALUE_SEP_BYTES + value.length + CRLF_BYTES;
  });
  return total;
};
