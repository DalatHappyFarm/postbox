#!/usr/bin/env node
import { run } from "./index.js";

run(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
