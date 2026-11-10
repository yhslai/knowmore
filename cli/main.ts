import { buildKnowledgeBaseCatalog, formatKnowledgeBaseCatalog } from "../extensions/knowmore/kb.js";
import type { KbIndexScope } from "../extensions/knowmore/kb-index.js";
import { loadConfig } from "../extensions/knowmore/core.js";
import { runKbIndexAction, type KbIndexActionOptions } from "./kb-index-action.js";
import { runMcpServer } from "./mcp-server.js";

const USAGE = [
	"Usage: node cli/knowmore.mjs <command>",
	"",
	"Commands:",
	"  mcp                       Run the knowmore MCP server over stdio (for Claude Code)",
	"  catalog                   Print the KB catalog resolved from the current directory",
	"  index update [--scope project|shared|all] [--all] [--source <id>]... [--reindex]",
	"  index status [--scope project|shared|all]",
	"  index clear  [--scope project|shared|all] [--source <id>]...",
	"",
	"Config and indexes are the same ones pi's knowmore extension uses.",
].join("\n");

function parseIndexArgs(args: string[]): KbIndexActionOptions {
	const action = args[0];
	if (action !== "update" && action !== "status" && action !== "clear") throw new Error(USAGE);
	let scope: KbIndexScope = action === "status" ? "all" : "project";
	let reindex = false;
	const sourceIds: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const token = args[i];
		if (token === "--scope") {
			const next = args[++i];
			if (next !== "project" && next !== "shared" && next !== "all") throw new Error("--scope must be one of: project, shared, all");
			scope = next;
		} else if (token === "--all") {
			scope = "all";
		} else if (token === "--source") {
			const next = args[++i];
			if (!next) throw new Error("--source requires a source ID");
			sourceIds.push(next);
		} else if (token === "--reindex") {
			reindex = true;
		} else {
			throw new Error(`Unknown argument: ${token}\n\n${USAGE}`);
		}
	}
	return { action, scope, sourceIds, reindex };
}

export async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	const cwd = process.cwd();
	try {
		if (command === "mcp") {
			await runMcpServer();
			return;
		}
		if (command === "catalog") {
			const loaded = loadConfig(cwd);
			const catalog = buildKnowledgeBaseCatalog(loaded.config, {
				globalConfigPath: loaded.globalConfigPath,
				projectConfigPath: loaded.projectConfigPath,
			});
			process.stdout.write(`${formatKnowledgeBaseCatalog(catalog)}\n`);
			return;
		}
		if (command === "index") {
			const options = parseIndexArgs(rest);
			options.onProgress = (line) => process.stderr.write(`${line}\n`);
			process.stdout.write(`${await runKbIndexAction(cwd, options)}\n`);
			return;
		}
		process.stderr.write(`${USAGE}\n`);
		process.exitCode = command ? 1 : 0;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
