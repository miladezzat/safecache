#!/usr/bin/env node
import { createMemoryCliAdapter, runSafeCacheCli } from "./index";

void main();

async function main(): Promise<void> {
  const result = await runSafeCacheCli(process.argv.slice(2), createMemoryCliAdapter());

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }

  process.exitCode = result.exitCode;
}
