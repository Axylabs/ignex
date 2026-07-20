import { get } from "../core/http";

export default get(() => ({ status: "ok", time: Date.now() }));