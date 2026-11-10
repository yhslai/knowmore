#!/usr/bin/env node
// Entry point for running knowmore outside pi (MCP server for Claude Code, terminal CLI).
// Runs the TypeScript sources directly via Node's built-in type stripping (Node >= 22.18 / 23.6).
// The sources use NodeNext-style "./foo.js" imports; this hook maps them to the sibling ".ts" file.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			(specifier.startsWith("./") || specifier.startsWith("../")) &&
			specifier.endsWith(".js") &&
			context.parentURL?.endsWith(".ts")
		) {
			const tsUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
			if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsUrl.href, context);
		}
		return nextResolve(specifier, context);
	},
});

const { main } = await import("./main.ts");
await main(process.argv.slice(2));
