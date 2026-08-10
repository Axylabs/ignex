// Route with a static `config` export (cache) and a constant response.
export const config = { cache: { maxAge: 60 } };

export default () => ({ about: true });
