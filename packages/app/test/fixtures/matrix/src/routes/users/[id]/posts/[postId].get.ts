import { get } from "@ignex/core/http";

/** GET /users/:id/posts/:postId — nested dynamic params. */
export default get(async (ctx) => ctx.json({ id: ctx.params.id, postId: ctx.params.postId }));
