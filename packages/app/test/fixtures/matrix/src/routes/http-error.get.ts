import { RequestError } from "@ignex/core";

/** Throws a typed HTTP error — the response pipeline must still decorate it. */
export default () => {
  throw new RequestError(422, "nope", "NOPE");
};
