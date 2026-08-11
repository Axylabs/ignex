/**
 * Input validation primitives (native-accelerated where proven): email, UUID,
 * IPv4 and IPv6 checks. Fallbacks use standard, robust regexes / Node `net`.
 */
import { isIP } from "node:net";
import { nativeFor } from "./runtime";
import { toBytes } from "./util";

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Native parity: castrum's validate_uuid accepts version-4 UUIDs only.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** Pure-TS email validation (the regex used when native is unavailable). */
export const validateEmailFallback = (input: string): boolean => EMAIL_RE.test(input);

/** Pure-TS UUID-v4 validation (regex used when native is unavailable). */
export const validateUuidFallback = (input: string): boolean => UUID_RE.test(input);

/** Pure-TS IPv4 validation (regex used when native is unavailable). */
export const validateIpv4Fallback = (input: string): boolean => IPV4_RE.test(input);

/** Pure-TS IPv6 validation (Node `net.isIP` used when native is unavailable). */
export const validateIpv6Fallback = (input: string): boolean => isIP(input) === 6;

export const validateEmail = (input: string): boolean => {
  const n = nativeFor("validateEmail");
  return n ? n.validateEmail(toBytes(input)) : validateEmailFallback(input);
};

export const validateUuid = (input: string): boolean => {
  const n = nativeFor("validateUuid");
  return n ? n.validateUuid(toBytes(input)) : validateUuidFallback(input);
};

export const validateIpv4 = (input: string): boolean => {
  const n = nativeFor("validateIpv4");
  return n ? n.validateIpv4(toBytes(input)) : validateIpv4Fallback(input);
};

export const validateIpv6 = (input: string): boolean => {
  const n = nativeFor("validateIpv6");
  return n ? n.validateIpv6(toBytes(input)) : validateIpv6Fallback(input);
};
