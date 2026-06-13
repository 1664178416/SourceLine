#!/usr/bin/env node
import { Command } from "commander";
import { registerCacheCommand } from "./commands/cache.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerInitCommand } from "./commands/init.js";
import { formatCliError } from "./errors.js";
import { readCliVersion } from "./version.js";

const program = new Command();

program
  .name("sourceline")
  .description("Every claim, traced.")
  .version(readCliVersion());

registerCheckCommand(program);
registerCacheCommand(program);
registerInitCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(formatCliError(error, { debug: process.env.SOURCELINE_DEBUG === "1" }));
  process.exitCode = 1;
});
