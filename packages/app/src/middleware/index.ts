import { requestId } from "./request-id.js";

// Custom global plugins (IgnexPlugin) wired into `src/app.config.ts` via the
// `plugins` array. Add your own middleware here.
export const middleware = [requestId()];
