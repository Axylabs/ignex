# File upload

Accept a multipart upload, sanitize the filename, store it, and serve it
back — including range requests (video seeking, resumable downloads).

**You'll need**: a running dev server.

## The upload route

Bodies are lazy — nothing is parsed until you read it:

```ts
// src/routes/upload.post.ts → POST /upload
import { post } from "@ignex/core/http";

export default post(async (ctx) => {
  const form = await ctx.body.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return ctx.json({ error: "file field is required" }, { status: 400 });
  }
  return ctx.json({ uploaded: file.name, size: file.size }, { status: 201 });
});
```

```sh
curl -k -X POST https://localhost:3000/upload -F 'file=@./cat.png'
# → 201 {"uploaded":"cat.png","size":48213}
```

## Persisting it safely

Write to a storage root with a **sanitized name** — never trust a client
filename. The reference app's uploader:

```ts
// src/routes/upload.post.ts — the storage half (inside the handler)
import { join } from "node:path";

const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_"); // strip tricks like ../
const dest = join("uploads", `${Date.now()}-${safeName}`);
await Bun.write(dest, file);
```

For real apps: generate the name yourself (`crypto.randomUUID()`), keep the
client's name as metadata, and store outside the web root. The static route
below already guards against traversal.

## Serving files back

```ts
// src/routes/files/[name].get.ts → GET /files/:name
import { get } from "@ignex/core/http";
import { sendFile } from "@ignex/core";
import { Type } from "typebox";
import { join } from "node:path";

export default get((ctx) => sendFile(ctx, join("uploads", ctx.params.name)), {
  params: Type.Object({ name: Type.String() }),
});
```

`sendFile` gives you, for free:

- **Range requests** — `Range: bytes=…` answered correctly, so
  `<video>` seeking and resumable downloads work.
- **Traversal guard** — the resolved path cannot escape the directory you
  gave it.
- **Content-Type + ETag** — from the file, conditional requests supported.

```sh
curl -k -O https://localhost:3000/files/cat.png
curl -k -H 'Range: bytes=0-99' -o part.bin https://localhost:3000/files/cat.png
# → 206 Partial Content
```

## Body limits

`server.maxRequestBodySize` defaults to a deliberate 64 MiB ceiling
(configurable in `src/app.config.ts`). Oversized uploads are rejected
before your handler runs. Put the edge proxy (Caddy/nginx) in front for
`--max-body` enforcement at the boundary too — see
[Deployment](../guide/deployment#3-tls-and-http2-at-the-proxy).

## What to notice

- **Lazy bodies** — routes that never read the body pay nothing for it.
- **The dangerous parts are handled** — traversal, range math, mime types.
- **Streaming-friendly** — `sendFile` streams from disk; no full-file
  buffering in memory.

Next: [Typed client](/examples/typed-client) — generate an SDK package
from your routes.
