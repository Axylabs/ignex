// The "moxt DX" hello world — named-export route.
import { get } from "@flux/core/http";

export const httpGet = get(() => "Hello World");
