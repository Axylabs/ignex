/**
 * Input validation primitives (native-accelerated where proven): email, UUID,
 * IPv4 and IPv6 checks. Fallbacks use standard, robust regexes / Node `net`.
 */
import { isIP } from "node:net";
import { getNative } from "./loader";
import { toBytes } from "./util";

const native = getNative();

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Native parity: castrum's validate_uuid accepts version-4 UUIDs only.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export const validateEmail = (input: string): boolean =>
  native ? native.validateEmail(toBytes(input)) : EMAIL_RE.test(input);

export const validateUuid = (input: string): boolean =>
  native ? native.validateUuid(toBytes(input)) : UUID_RE.test(input);

export const validateIpv4 = (input: string): boolean =>
  native ? native.validateIpv4(toBytes(input)) : IPV4_RE.test(input);

export const validateIpv6 = (input: string): boolean =>
  native ? native.validateIpv6(toBytes(input)) : isIP(input) === 6;
