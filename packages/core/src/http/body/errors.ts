/**
 * @fileoverview Body parsing errors.
 */

import { HTTPError } from "../../platform/errors";

/**
 * Raised when a request body cannot be parsed (malformed JSON, oversize,
 * unsupported content type). Extends {@link HTTPError} so it flows through
 * `errorToResponse` with its `status` intact instead of leaking as a 500.
 */
export class BodyParseError extends HTTPError {
  constructor(message: string, status = 400) {
    super(status, message, "BODY_PARSE_ERROR");
    this.name = "BodyParseError";
  }
}
