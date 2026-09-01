// App runtime config used by compile tests (resolved via an absolute path).
export const plugins = [];

export const lifecycle = {
  request: [(ctx) => ctx],
};

export const server = {
  port: 3000,
};
