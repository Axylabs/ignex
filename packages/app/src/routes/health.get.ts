import { get } from "@flux/core/http";

export default get(() => ({ status: "ok", time: Date.now() }));
