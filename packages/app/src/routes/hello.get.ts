// Hello world — named-export route (`export const httpGet = get(...)`).
import { get } from "@flux/core/http";

export const httpGet = get(() => "Hello World");
