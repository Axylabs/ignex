import { get } from "@ignus/core/http";

export default get(() => ({ status: "ok", time: Date.now() }));
