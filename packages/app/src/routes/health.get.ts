import { get } from "@ignex/core/http";

export default get(() => ({ status: "ok", time: Date.now() }));
