import { get } from "@ignex/core/http";

/** GET /download — streams a fixed-size payload (1 MiB) as octet-stream. */
export default get((ctx) => {
  const total = 1024 * 1024;
  const chunk = new Uint8Array(1024).fill(0x61); // 'a'
  let sent = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.length;
    },
  });

  return ctx.stream(stream, {
    headers: { "content-type": "application/octet-stream" },
  });
});
