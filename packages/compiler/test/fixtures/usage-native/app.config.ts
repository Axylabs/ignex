// A lifecycle that forces the full-context path (like a real app config).
export const plugins = [];

export const lifecycle = {
  request: [(ctx) => ctx],
};

export const server = { port: 3000 };
