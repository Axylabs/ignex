// Constant JSON response — hoisted to a frozen body; statically sync, no
// wildcard → `static-sync` wrapper + build-time HEAD handler.
export default () => ({ hello: "world" });
