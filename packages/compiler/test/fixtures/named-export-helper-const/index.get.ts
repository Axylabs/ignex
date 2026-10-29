// Regression: a pure helper exported BEFORE the handler must not be mistaken
// for the handler by constant-response analysis (which would hoist "helper"
// as the response body).
import { get } from "@ignex/core/http";

export const helper = () => "helper";

export const httpGet = get(() => ({ ok: true }));
