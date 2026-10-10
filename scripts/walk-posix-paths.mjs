#!/usr/bin/env node
import { walkPosixPaths } from "../src/walk-posix-paths.mjs";

function parseArgs(argv) {
  const args = { root: null, excludes: [], format: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = argv[(index += 1)];
    else if (arg === "--exclude") args.excludes.push(argv[(index += 1)]);
    else if (arg === "--format") args.format = argv[(index += 1)];
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return args;
}

function summary(walk) {
  const bytes = walk.files.reduce((sum, file) => sum + file.bytes, 0);
  return [
    `root: ${walk.root}`,
    `files: ${walk.files.length}`,
    `directories: ${walk.directories}`,
    `excluded: ${walk.excluded}`,
    `bytes: ${bytes}`,
    "",
  ].join("\n");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) throw new Error("--root is required");
  if (args.format !== "json" && args.format !== "summary") throw new Error(`unknown --format ${args.format} (want json|summary)`);
  const walk = await walkPosixPaths({ root: args.root, excludes: args.excludes });
  process.stdout.write(args.format === "json" ? `${JSON.stringify(walk, null, 2)}\n` : summary(walk));
} catch (error) {
  process.stderr.write(`walk-posix-paths: ${error.message}\n`);
  process.exitCode = 64;
}
