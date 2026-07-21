#!/usr/bin/env bun
import { main } from "../dist/index.js";

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
