// Statically hook-free config: an empty plugins array and an all-empty
// lifecycle object contribute no per-request hooks, so AOT optimizations
// (constant hoisting → static Response promotion, context specialization)
// stay enabled even though the exports exist.
export const plugins = [];

export const lifecycle = {
  request: [],
};

export const server = {
  port: 3000,
};
