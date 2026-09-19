// Constant Response literal with a static init — same hoist as the JSON arm.
export default () => new Response("ready", { status: 200, headers: { "x-ready": "1" } });
