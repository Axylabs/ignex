#!/usr/bin/env bun
import { main } from "../src/index.ts";

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
