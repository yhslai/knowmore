// Minimal MCP (Model Context Protocol) stdio server exposing knowmore's local KB tools to Claude Code.
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. Nothing but protocol messages may go to stdout.
import * as readline from "node:readline";

import { formatKnowledgeBaseCatalog } from "../extensions/knowmore/kb.js";
import { getKbIndexStatus, pickKbIndexPath, resolveKbIndexPaths, type KbIndexScope } from "../extensions/knowmore/kb-index.js";
import {
	buildMissingKnowledgeBaseReferencesError,
} from "../extensions/knowmore/kb.js";
import {
	getOrBuildKbCatalogContext,
	invalidateKbCatalogCache,
	runKbSearch,
	runKbUnionSearch,
} from "../extensions/knowmore/core.js";
import { runKbIndexAction } from "./kb-index-action.js";

const SERVER_NAME = "knowmore";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: any;
}

const scopeSchema = {
	type: "string",
	enum: ["project", "shared", "all"],
	description: "Which index to search: project for project-* sources, shared for shared-* sources, all for both.",
	default: "all",
};

const TOOLS = [
	{
		name: "kb_search",
		description: [
			"Search the local knowledge base (the same indexed documents pi's knowmore uses) with lexical BM25 ranking over SQLite FTS5.",
			"Only exact words match (porter-stemmed), no semantic retrieval — keep queries concise. FTS5 syntax is allowed (AND/OR/NOT, \"phrases\", prefix*).",
			"If unsure of the exact terms, prefer kb_union_search with synonyms in any[].",
			"Results are chunk snippets with file:line ranges; Read the source file for more context.",
		].join(" "),
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Lexical search query" },
				scope: scopeSchema,
				sourceIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Optional source IDs (from kb_catalog / server instructions) to scope search" },
				topK: { type: "integer", minimum: 1, maximum: 50, default: 8 },
				pathPrefix: { type: "string", description: "Optional absolute path prefix filter" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "kb_union_search",
		description: [
			"Search the local knowledge base with a structured query: every clause in all[] must match AND at least one clause in any[] must match.",
			"Each clause is matched as a phrase. Most of the time leave all[] empty and put the term plus synonyms/related terms in any[] for broad coverage.",
			"distill defaults to false (raw chunks returned). distill=true expands each hit's surrounding file context and compresses it via the configured OpenRouter distiller model (costs an external API call); use intent to steer it.",
			"Stop once you have enough information.",
		].join(" "),
		inputSchema: {
			type: "object",
			properties: {
				all: { type: "array", items: { type: "string", minLength: 1 }, description: "Only return results that match all these clauses." },
				any: { type: "array", items: { type: "string", minLength: 1 }, description: "Return results that match at least one of these clauses." },
				scope: scopeSchema,
				sourceIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Optional source IDs to scope search" },
				topK: { type: "integer", minimum: 1, maximum: 100, default: 20 },
				pathPrefix: { type: "string", description: "Optional absolute path prefix filter" },
				distill: { type: "boolean", default: false, description: "If true, expand local context and distill via the OpenRouter distiller before returning." },
				intent: { type: "string", description: "Optional distillation intent to guide what evidence should be prioritized." },
				maxChunksToDistill: { type: "integer", minimum: 1, maximum: 30, default: 20 },
				maxCharsPerChunk: { type: "integer", minimum: 400, maximum: 12000, default: 5000 },
			},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "kb_catalog",
		description:
			"List the local KB roots and source IDs (with descriptions), the working directory used to resolve the project KB, and per-index status. Use it to pick sourceIds/scope.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "kb_index_update",
		description: [
			"Incrementally (re)index local KB sources into the shared SQLite index (unchanged files are skipped).",
			"Only run when the user asks or search results are clearly stale. A large shared KB can take minutes; for that, prefer running",
			"`node <knowmore>/cli/knowmore.mjs index update --scope shared` in the background via the shell instead.",
		].join(" "),
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["project", "shared", "all"], description: "Which index to update." },
				sourceIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Optional source IDs to limit the update" },
				reindex: { type: "boolean", default: false, description: "Force re-indexing files even if unchanged." },
			},
			required: ["scope"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
];

function buildInstructions(cwd: string): string {
	const lines = [
		"knowmore: local knowledge-base (KB) retrieval over documents indexed into SQLite FTS5 (shared with the pi harness).",
		"Use kb_union_search / kb_search when the user's question may be answered by their local docs (project KB or shared KB), before guessing or searching the web.",
		"Search is lexical, not semantic: use concrete terms and synonyms. After finding a relevant chunk, Read the file for full context.",
	];
	try {
		invalidateKbCatalogCache();
		const { context } = getOrBuildKbCatalogContext(cwd);
		const sources = context.catalog.sources;
		const shown = sources.slice(0, 120);
		lines.push("", `KB sources (${shown.length}/${sources.length}; project KB resolved from ${cwd}):`);
		if (shown.length === 0) lines.push("- (none)");
		for (const source of shown) lines.push(`- ${source.id}${source.description ? ` — ${source.description}` : ""}`);
		if (sources.length > shown.length) lines.push(`- ... ${sources.length - shown.length} more; call kb_catalog for the full list`);
		lines.push("Pass these IDs as sourceIds; set scope to project/shared/all according to the ID prefix.");
		const missing = buildMissingKnowledgeBaseReferencesError(context.catalog);
		if (missing) lines.push("", `Warning: ${missing}`);
	} catch (error) {
		lines.push("", `Warning: KB catalog unavailable (${error instanceof Error ? error.message : String(error)}). Call kb_catalog for details.`);
	}
	return lines.join("\n");
}

function catalogReport(cwd: string): string {
	invalidateKbCatalogCache();
	const { context } = getOrBuildKbCatalogContext(cwd);
	const paths = resolveKbIndexPaths(cwd, context.loaded.projectConfigPath);
	const scopes: Array<Exclude<KbIndexScope, "all">> = ["project", "shared"];
	const indexLines = scopes.map((scope) => {
		const indexPath = pickKbIndexPath(paths, scope);
		if (!indexPath.available) return `- ${scope}: (no project knowmore.config.json found from cwd)`;
		const status = getKbIndexStatus(indexPath.dbPath);
		if (!status.exists) return `- ${scope}: not built (${indexPath.dbPath})`;
		const files = status.sourceStats.reduce((sum, row) => sum + row.fileCount, 0);
		const chunks = status.sourceStats.reduce((sum, row) => sum + row.chunkCount, 0);
		return `- ${scope}: ${indexPath.dbPath} | sources=${status.sourceStats.length} files=${files} chunks=${chunks} | lastUpdatedAt=${status.meta.lastUpdatedAt ?? "?"}`;
	});
	return [
		`cwd: ${cwd}`,
		`globalConfig: ${context.loaded.globalConfigPath ?? "(none)"}`,
		`projectConfig: ${context.loaded.projectConfigPath ?? "(none)"}`,
		"",
		formatKnowledgeBaseCatalog(context.catalog),
		"",
		"Indexes:",
		...indexLines,
	].join("\n");
}

async function callTool(name: string, args: any, cwd: string): Promise<string> {
	// The server is long-lived and the KB may be re-indexed by another process (pi, CLI); always rebuild the cheap catalog.
	invalidateKbCatalogCache();
	switch (name) {
		case "kb_search":
			return runKbSearch(cwd, args).text;
		case "kb_union_search":
			return (await runKbUnionSearch(cwd, args)).text;
		case "kb_catalog":
			return catalogReport(cwd);
		case "kb_index_update":
			return runKbIndexAction(cwd, {
				action: "update",
				scope: args.scope,
				sourceIds: args.sourceIds,
				reindex: args.reindex,
				onProgress: (line) => process.stderr.write(`${line}\n`),
			});
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

function send(message: Json): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request: JsonRpcRequest, cwd: string): Promise<void> {
	const hasId = request.id !== undefined && request.id !== null;
	const reply = (result: Json) => hasId && send({ jsonrpc: "2.0", id: request.id!, result });
	const fail = (code: number, message: string) => hasId && send({ jsonrpc: "2.0", id: request.id!, error: { code, message } });

	switch (request.method) {
		case "initialize": {
			const requested = request.params?.protocolVersion;
			const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]!;
			reply({
				protocolVersion,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				instructions: buildInstructions(cwd),
			});
			return;
		}
		case "ping":
			reply({});
			return;
		case "tools/list":
			reply({ tools: TOOLS as unknown as Json });
			return;
		case "tools/call": {
			const name = request.params?.name;
			const args = request.params?.arguments ?? {};
			try {
				const text = await callTool(name, args, cwd);
				reply({ content: [{ type: "text", text }] });
			} catch (error) {
				reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
			}
			return;
		}
		default:
			if (request.method.startsWith("notifications/")) return;
			fail(-32601, `Method not found: ${request.method}`);
	}
}

export async function runMcpServer(): Promise<void> {
	// Claude Code spawns MCP servers with the session's project directory as cwd; KNOWMORE_CWD overrides it.
	const cwd = process.env.KNOWMORE_CWD?.trim() || process.cwd();
	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	const pending = new Set<Promise<void>>();

	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let request: JsonRpcRequest;
		try {
			request = JSON.parse(trimmed);
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			continue;
		}
		const task = handle(request, cwd).catch((error) => {
			process.stderr.write(`knowmore mcp: ${error instanceof Error ? error.stack : String(error)}\n`);
		});
		pending.add(task);
		task.finally(() => pending.delete(task));
	}
	await Promise.all(pending);
}
