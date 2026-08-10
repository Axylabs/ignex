// Non-pure (Date.now), so it is imported as a regular handler.
export default () => ({ status: "ok", time: Date.now() });
