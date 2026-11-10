// Harness-independent knowmore core: config loading, KB catalog, KB search orchestration, distiller.
// Shared by the pi extension (index.ts) and the MCP server (../../mcp).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildKnowledgeBaseCatalog,
	ensureKnowledgeBaseReferencesExist,
	type KnowledgeBaseCatalogResult,
	type KnowmoreKnowledgeBaseConfig,
} from "./kb.js";
import {
	formatKbSearchResult,
	formatKbUnionSearchResult,
	pickKbIndexPath,
	resolveKbIndexPaths,
	searchKbIndex,
	searchKbIndexUnion,
	type KbIndexScope,
} from "./kb-index.js";
import { looksLikeHtmlDocument, preprocessDocumentTextForDistiller } from "./content-cleaning.js";

export interface DistillerSettings {
	openrouterApiKey: string;
	model: string;
}

export interface KnowmoreConfig extends KnowmoreKnowledgeBaseConfig {
	web?: {
		braveApiKey?: string;
	};
	distiller?: {
		openrouterApiKey?: string;
		model?: string;
	};
}

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_APP_TITLE = "knowmore-distiller";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const GLOBAL_CONFIG_DEFAULT_FILE = "knowmore.config.default.json";
export const PROJECT_CONFIG_FILE = "knowmore.config.json";

export const KB_CATALOG_PROMPT_START = "<!-- knowmore:kb-catalog:start -->";
export const KB_CATALOG_PROMPT_END = "<!-- knowmore:kb-catalog:end -->";

export interface PromptKbSourceEntry {
	id: string;
	description?: string;
}

export interface CachedKbCatalogContext {
	cwd: string;
	computedAt: number;
	loaded: {
		config: KnowmoreConfig;
		globalConfigPath: string | null;
		projectConfigPath: string | null;
	};
	catalog: KnowledgeBaseCatalogResult;
	promptSources: PromptKbSourceEntry[];
	promptInjection: string;
}

let cachedKbCatalogContext: CachedKbCatalogContext | null = null;

export function getPackageRootPath(): string {
	const extensionFile = fileURLToPath(import.meta.url);
	const extensionDir = path.dirname(extensionFile);
	return path.resolve(extensionDir, "..", "..");
}

export function getDefaultGlobalConfigPath(): string {
	return path.join(getPackageRootPath(), GLOBAL_CONFIG_DEFAULT_FILE);
}


export function getGlobalConfigPath(): string | null {
	const envPath = process.env.KNOWMORE_CONFIG_PATH?.trim();
	if (envPath) {
		const resolved = path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
		if (!fs.existsSync(resolved)) {
			throw new Error(`KNOWMORE_CONFIG_PATH is set but file was not found at ${resolved}`);
		}
		return resolved;
	}

	const defaultPath = getDefaultGlobalConfigPath();
	if (fs.existsSync(defaultPath)) return defaultPath;

	return null;
}

export function findNearestProjectConfigPath(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, PROJECT_CONFIG_FILE);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function readConfigFile(configPath: string): KnowmoreConfig {
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf-8");
	} catch (error) {
		throw new Error(`Failed reading Knowmore config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON in Knowmore config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error(`Knowmore config at ${configPath} must be a JSON object.`);
	}

	return parsed as KnowmoreConfig;
}

export function mergeConfigs(baseConfig: KnowmoreConfig, overrideConfig: KnowmoreConfig): KnowmoreConfig {
	return {
		...baseConfig,
		...overrideConfig,
		web: {
			...baseConfig.web,
			...overrideConfig.web,
		},
		distiller: {
			...baseConfig.distiller,
			...overrideConfig.distiller,
		},
	};
}

export function loadConfig(cwd?: string): { config: KnowmoreConfig; globalConfigPath: string | null; projectConfigPath: string | null } {
	const globalConfigPath = getGlobalConfigPath();
	const projectConfigPath = cwd ? findNearestProjectConfigPath(cwd) : null;

	if (!globalConfigPath && !projectConfigPath) {
		throw new Error(
			`No Knowmore config file found. Create ${GLOBAL_CONFIG_DEFAULT_FILE} from knowmore.config.example.json, or add ${PROJECT_CONFIG_FILE} in your project.`,
		);
	}

	let config: KnowmoreConfig = {};

	if (globalConfigPath) {
		const globalConfig = readConfigFile(globalConfigPath);
		config = mergeConfigs(config, globalConfig);
	}

	if (projectConfigPath && (!globalConfigPath || path.resolve(projectConfigPath) !== path.resolve(globalConfigPath))) {
		const projectConfig = readConfigFile(projectConfigPath);
		config = mergeConfigs(config, projectConfig);
	}

	return { config, globalConfigPath, projectConfigPath };
}

export function requireBraveApiKey(config: KnowmoreConfig): string {
	const apiKey = config.web?.braveApiKey;
	if (!apiKey || apiKey.trim().length === 0) {
		throw new Error("web.braveApiKey is missing in effective Knowmore config.");
	}
	return apiKey;
}

export function requireDistillerSettings(config: KnowmoreConfig): DistillerSettings {
	const openrouterApiKey = config.distiller?.openrouterApiKey;
	if (!openrouterApiKey || openrouterApiKey.trim().length === 0) {
		throw new Error("distiller.openrouterApiKey is missing in effective Knowmore config.");
	}

	const model = config.distiller?.model;
	if (!model || model.trim().length === 0) {
		throw new Error("distiller.model is missing in effective Knowmore config.");
	}

	return { openrouterApiKey: openrouterApiKey.trim(), model: model.trim() };
}

export function maskApiKey(apiKey: string): string {
	if (apiKey.length <= 8) return "***";
	return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function validateKbIndexSourceIds(catalog: KnowledgeBaseCatalogResult, scope: KbIndexScope, sourceIds?: string[]): void {
	const ids = (sourceIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
	if (ids.length === 0) return;

	const scopedSources = catalog.sources.filter((source) => {
		if (scope === "all") return true;
		return source.rootId === scope;
	});
	const available = new Set(scopedSources.map((source) => source.id));
	const unknown = ids.filter((id) => !available.has(id)).sort((a, b) => a.localeCompare(b));
	if (unknown.length === 0) return;

	const availableList = [...available].sort((a, b) => a.localeCompare(b));
	const preview = availableList.slice(0, 20);
	const previewSuffix = availableList.length > preview.length ? " ..." : "";
	throw new Error(
		`Unknown source ID(s) for scope '${scope}': ${unknown.join(", ")}${availableList.length > 0 ? `\nAvailable: ${preview.join(", ")}${previewSuffix}` : "\nNo sources available for this scope."}`,
	);
}

export function resolveScopes(scope: KbIndexScope): Array<Exclude<KbIndexScope, "all">> {
	return scope === "all" ? ["project", "shared"] : [scope];
}

export function mergeRankedResults<T extends { score: number }>(lists: T[][], topK: number): T[] {
	const merged = lists.flat();
	merged.sort((a, b) => a.score - b.score);
	return merged.slice(0, Math.max(1, topK));
}

export function buildPromptKbSources(catalog: KnowledgeBaseCatalogResult): PromptKbSourceEntry[] {
	const maxSourcesInPrompt = 120;
	return catalog.sources.slice(0, maxSourcesInPrompt).map((source) => ({
		id: source.id,
		description: source.description,
	}));
}

export function buildKbCatalogPromptInjection(promptSources: PromptKbSourceEntry[], totalSources: number): string {
	const lines: string[] = [];
	lines.push(KB_CATALOG_PROMPT_START);
	lines.push("KB sources available (cached by knowmore extension):");

	if (promptSources.length === 0) {
		lines.push("- (none)");
	} else {
		lines.push(`- sourceIds (showing ${promptSources.length}/${totalSources}):`);
		for (const source of promptSources) {
			const descriptionText = source.description ? ` — ${source.description}` : "";
			lines.push(`  - ${source.id}${descriptionText}`);
		}
		if (totalSources > promptSources.length) {
			lines.push(`  - ... ${totalSources - promptSources.length} additional source(s) omitted`);
		}
	}

	lines.push("Use these source IDs directly with kb_search.sourceIds, kb_union_search.sourceIds, or /kb-index --source.");
	lines.push("Set kb_search/kb_union_search scope to project/shared/all based on source IDs.");
	lines.push(KB_CATALOG_PROMPT_END);
	return lines.join("\n");
}

export function stripInjectedKbCatalogPrompt(systemPrompt: string): string {
	const start = systemPrompt.indexOf(KB_CATALOG_PROMPT_START);
	if (start < 0) return systemPrompt;
	const end = systemPrompt.indexOf(KB_CATALOG_PROMPT_END, start);
	if (end < 0) return systemPrompt;
	const afterEnd = end + KB_CATALOG_PROMPT_END.length;
	const leading = systemPrompt.slice(0, start).trimEnd();
	const trailing = systemPrompt.slice(afterEnd).trimStart();
	if (!leading) return trailing;
	if (!trailing) return leading;
	return `${leading}\n\n${trailing}`;
}

export function getCachedKbCatalogContextForCwd(cwd: string): CachedKbCatalogContext | null {
	const resolvedCwd = path.resolve(cwd);
	if (!cachedKbCatalogContext) return null;
	if (cachedKbCatalogContext.cwd !== resolvedCwd) return null;
	return cachedKbCatalogContext;
}

export function buildAndCacheKbCatalogContext(cwd: string, loaded?: { config: KnowmoreConfig; globalConfigPath: string | null; projectConfigPath: string | null }): CachedKbCatalogContext {
	const resolvedCwd = path.resolve(cwd);
	const resolvedLoaded = loaded ?? loadConfig(resolvedCwd);
	const catalog = buildKnowledgeBaseCatalog(resolvedLoaded.config, {
		globalConfigPath: resolvedLoaded.globalConfigPath,
		projectConfigPath: resolvedLoaded.projectConfigPath,
	});

	const promptSources = buildPromptKbSources(catalog);
	const context: CachedKbCatalogContext = {
		cwd: resolvedCwd,
		computedAt: Date.now(),
		loaded: resolvedLoaded,
		catalog,
		promptSources,
		promptInjection: buildKbCatalogPromptInjection(promptSources, catalog.sources.length),
	};
	cachedKbCatalogContext = context;
	return context;
}

export function getOrBuildKbCatalogContext(cwd: string): { context: CachedKbCatalogContext; cacheHit: boolean } {
	const cached = getCachedKbCatalogContextForCwd(cwd);
	if (cached) return { context: cached, cacheHit: true };
	return { context: buildAndCacheKbCatalogContext(cwd), cacheHit: false };
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	if (signal) {
		if (signal.aborted) {
			clearTimeout(timeout);
			throw new Error("Request aborted");
		}
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

export function readLocalChunkContext(
	filePath: string,
	startLine: number,
	endLine: number,
	maxChars: number,
): { content: string; rangeStart: number; rangeEnd: number; error?: string } {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		if (looksLikeHtmlDocument(undefined, filePath)) {
			const cleaned = preprocessDocumentTextForDistiller(raw, { filePath });
			return {
				content: truncate(cleaned, maxChars),
				rangeStart: 1,
				rangeEnd: Math.max(1, cleaned.split("\n").length),
			};
		}

		const lines = raw.split(/\r?\n/);
		if (lines.length === 0) {
			return { content: "", rangeStart: 1, rangeEnd: 1 };
		}

		const fileStart = 1;
		const fileEnd = lines.length;
		let rangeStart = Math.max(fileStart, Math.min(fileEnd, startLine));
		let rangeEnd = Math.max(fileStart, Math.min(fileEnd, endLine));
		if (rangeStart > rangeEnd) [rangeStart, rangeEnd] = [rangeEnd, rangeStart];

		const lineWithNumber = (lineNumber: number): string => `${lineNumber}: ${lines[lineNumber - 1] ?? ""}`;
		const joinedLength = (parts: string[]): number => {
			if (parts.length === 0) return 0;
			return parts.reduce((sum, p) => sum + p.length, 0) + (parts.length - 1);
		};

		let selected = Array.from({ length: rangeEnd - rangeStart + 1 }, (_, i) => lineWithNumber(rangeStart + i));
		let totalChars = joinedLength(selected);

		if (totalChars > maxChars) {
			return {
				content: truncate(selected.join("\n"), maxChars),
				rangeStart,
				rangeEnd,
			};
		}

		while (true) {
			let expanded = false;

			if (rangeStart > fileStart) {
				const candidate = lineWithNumber(rangeStart - 1);
				const projected = totalChars + (selected.length > 0 ? 1 : 0) + candidate.length;
				if (projected <= maxChars) {
					rangeStart -= 1;
					selected.unshift(candidate);
					totalChars = projected;
					expanded = true;
				}
			}

			if (rangeEnd < fileEnd) {
				const candidate = lineWithNumber(rangeEnd + 1);
				const projected = totalChars + (selected.length > 0 ? 1 : 0) + candidate.length;
				if (projected <= maxChars) {
					rangeEnd += 1;
					selected.push(candidate);
					totalChars = projected;
					expanded = true;
				}
			}

			if (!expanded) break;
			if (rangeStart === fileStart && rangeEnd === fileEnd) break;
		}

		return {
			content: selected.join("\n"),
			rangeStart,
			rangeEnd,
		};
	} catch (error) {
		return {
			content: "",
			rangeStart: startLine,
			rangeEnd: endLine,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface DistillerSourceInput {
	index: number;
	title: string;
	url: string;
	snippet: string;
	content: string;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function estimateDistillerBudget(query: string, sources: DistillerSourceInput[]): { wordLimit: number; maxTokens: number } {
	const totalInputChars =
		query.length +
		sources.reduce((sum, source) => sum + source.title.length + source.url.length + source.snippet.length + source.content.length, 0);

	const wordLimit = clamp(Math.round(totalInputChars / 20), 300, 4000);
	const maxTokens = clamp(Math.ceil(wordLimit * 1.8), 320, 4096);
	return { wordLimit, maxTokens };
}

export async function runDistillerModel(
	settings: DistillerSettings,
	query: string,
	sources: DistillerSourceInput[],
	signal?: AbortSignal,
	intent?: string,
): Promise<string> {
	const budget = estimateDistillerBudget(query, sources);
	const normalizedIntent = typeof intent === "string" ? intent.trim() : "";
	const prompt = [
		"You are a distiller model used by a coding assistant.",
		"Task: distill web evidence into compact, useful context for another model.",
		"Rules:",
		"- Focus on information relevant to the query.",
		"- Treat intent (if provided) as the highest-priority guidance for what to extract.",
		"- Prefer concrete facts; avoid speculation.",
		"- If evidence is weak/conflicting, explicitly say so.",
		"- Preserve source references inline like [S1], [S2] where appropriate.",
		"- Do not write a final user-facing answer; write context for another model.",
		`- Keep output around ${budget.wordLimit} words (roughly ±20%, shorter if evidence is sparse).`,
		"",
		normalizedIntent.length > 0 ? `Intent: ${normalizedIntent}` : undefined,
		`Query: ${query}`,
		"",
		"Sources:",
		...sources.map((s) => `S${s.index}: ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}\nContent: ${s.content}`),
	]
		.filter((line): line is string => typeof line === "string")
		.join("\n");

	const response = await fetchWithTimeout(
		OPENROUTER_CHAT_URL,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${settings.openrouterApiKey}`,
                "HTTP-Referer": "http://localhost",
				"X-OpenRouter-Title": OPENROUTER_APP_TITLE,
                "X-OpenRouter-Categories": "cli-agent",
			},
			body: JSON.stringify({
				model: settings.model,
				temperature: 0.2,
				max_tokens: budget.maxTokens,
				messages: [
					{ role: "system", content: "You are a precise evidence distiller." },
					{ role: "user", content: prompt },
				],
			}),
		},
		DEFAULT_TIMEOUT_MS,
		signal,
	);

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`OpenRouter distiller call failed (${response.status}): ${truncate(body, 300)}`);
	}

	const data = (await response.json()) as {
		choices?: Array<{
			message?: { content?: string | Array<{ type?: string; text?: string }> };
		}>;
	};

	const content = data.choices?.[0]?.message?.content;
	if (typeof content === "string" && content.trim().length > 0) return content.trim();
	if (Array.isArray(content)) {
		const joined = content
			.map((p) => (typeof p?.text === "string" ? p.text : ""))
			.join("")
			.trim();
		if (joined.length > 0) return joined;
	}

	throw new Error("OpenRouter distiller returned empty content.");
}
export interface KbSearchParams {
	query: string;
	scope?: KbIndexScope;
	sourceIds?: string[];
	topK?: number;
	pathPrefix?: string;
}

export interface KbUnionSearchParams {
	all?: string[];
	any?: string[];
	scope?: KbIndexScope;
	sourceIds?: string[];
	topK?: number;
	pathPrefix?: string;
	distill?: boolean;
	intent?: string;
	maxChunksToDistill?: number;
	maxCharsPerChunk?: number;
}

export interface KbToolOutput {
	text: string;
	details: Record<string, unknown>;
}

// Indexed file paths are stored via path.resolve (native separators), so normalize absolute prefixes the same way.
function normalizePathPrefix(pathPrefix?: string): string | undefined {
	const trimmed = pathPrefix?.trim();
	if (!trimmed) return undefined;
	return path.isAbsolute(trimmed) ? path.resolve(trimmed) : trimmed;
}

function collectFromIndexes<T>(
	cwd: string,
	projectConfigPath: string | null,
	scope: KbIndexScope,
	toolName: string,
	search: (dbPath: string) => T,
): { results: T[]; dbPaths: string[] } {
	const paths = resolveKbIndexPaths(cwd, projectConfigPath);
	const targetScopes = resolveScopes(scope);
	const results: T[] = [];
	const dbPaths: string[] = [];

	for (const targetScope of targetScopes) {
		const indexPath = pickKbIndexPath(paths, targetScope);
		if (targetScope === "project" && !indexPath.available) {
			if (scope === "project") {
				throw new Error(`${toolName} scope=project requires running inside a project (knowmore.config.json).`);
			}
			continue;
		}
		if (!fs.existsSync(indexPath.dbPath)) continue;
		dbPaths.push(indexPath.dbPath);
		results.push(search(indexPath.dbPath));
	}

	if (results.length === 0) {
		const checked = targetScopes.map((s) => pickKbIndexPath(paths, s).dbPath).join(", ");
		throw new Error(`No KB index found for scope='${scope}'. Run a kb-index update first. Checked: ${checked}`);
	}
	return { results, dbPaths };
}

export function runKbSearch(cwd: string, params: KbSearchParams): KbToolOutput {
	const { context } = getOrBuildKbCatalogContext(cwd);
	ensureKnowledgeBaseReferencesExist(context.catalog);
	const scope: KbIndexScope = params.scope ?? "all";
	validateKbIndexSourceIds(context.catalog, scope, params.sourceIds);
	const topK = params.topK ?? 8;
	const pathPrefix = normalizePathPrefix(params.pathPrefix);

	const { results, dbPaths } = collectFromIndexes(cwd, context.loaded.projectConfigPath, scope, "kb_search", (dbPath) =>
		searchKbIndex(dbPath, { query: params.query, topK, sourceIds: params.sourceIds, pathPrefix }),
	);

	const result = {
		dbPath: dbPaths.join(", "),
		query: params.query,
		topK,
		results: mergeRankedResults(results.map((r) => r.results), topK),
	};
	return { text: formatKbSearchResult(result), details: result };
}

export async function runKbUnionSearch(cwd: string, params: KbUnionSearchParams, signal?: AbortSignal): Promise<KbToolOutput> {
	const { context } = getOrBuildKbCatalogContext(cwd);
	ensureKnowledgeBaseReferencesExist(context.catalog);
	const scope: KbIndexScope = params.scope ?? "all";
	validateKbIndexSourceIds(context.catalog, scope, params.sourceIds);
	const topK = params.topK ?? 20;
	const pathPrefix = normalizePathPrefix(params.pathPrefix);

	const { results, dbPaths } = collectFromIndexes(cwd, context.loaded.projectConfigPath, scope, "kb_union_search", (dbPath) =>
		searchKbIndexUnion(dbPath, { all: params.all ?? [], any: params.any, topK, sourceIds: params.sourceIds, pathPrefix }),
	);

	const first = results[0]!;
	const result = {
		dbPath: dbPaths.join(", "),
		query: first.query,
		topK,
		all: first.all,
		any: first.any,
		matchQuery: first.matchQuery,
		results: mergeRankedResults(results.map((r) => r.results), topK),
	};

	if (!params.distill || result.results.length === 0) {
		return { text: formatKbUnionSearchResult(result), details: { ...result, distilled: false } };
	}

	const { config } = loadConfig(cwd);
	const distiller = requireDistillerSettings(config);
	const maxChunksToDistill = params.maxChunksToDistill ?? 20;
	const maxCharsPerChunk = params.maxCharsPerChunk ?? 5000;

	const selected = result.results.slice(0, maxChunksToDistill);
	const sourceInputs: DistillerSourceInput[] = [];
	const readErrors: Array<{ filePath: string; error: string }> = [];

	for (let i = 0; i < selected.length; i++) {
		const item = selected[i]!;
		const contextRead = readLocalChunkContext(item.filePath, item.startLine, item.endLine, maxCharsPerChunk);
		if (contextRead.error) {
			readErrors.push({ filePath: item.filePath, error: contextRead.error });
		}
		sourceInputs.push({
			index: i + 1,
			title: `[${item.sourceId}] ${path.basename(item.filePath)}:${item.startLine}-${item.endLine}`,
			url: `file://${item.filePath}`,
			snippet: truncate(preprocessDocumentTextForDistiller(item.text, { filePath: item.filePath }), 600),
			content:
				contextRead.content.length > 0
					? `File: ${item.filePath}\nContext lines: ${contextRead.rangeStart}-${contextRead.rangeEnd}\n${contextRead.content}`
					: `File: ${item.filePath}\nChunk lines: ${item.startLine}-${item.endLine}\n${truncate(preprocessDocumentTextForDistiller(item.text, { filePath: item.filePath }), maxCharsPerChunk)}`,
		});
	}

	const intent = typeof params.intent === "string" ? params.intent.trim() : "";
	const distillQuery = `Local KB union search. ALL: ${result.all.join(", ")}${result.any.length > 0 ? ` | ANY: ${result.any.join(" | ")}` : ""}`;
	const distilled = await runDistillerModel(distiller, distillQuery, sourceInputs, signal, intent || undefined);
	const sourceMap = sourceInputs.map((s) => ({ index: s.index, title: s.title, url: s.url }));

	return {
		text: `Distilled local KB union context\nALL: ${result.all.join(", ")}${result.any.length > 0 ? `\nANY: ${result.any.join(" | ")}` : ""}${intent ? `\nIntent: ${intent}` : ""}\n\n${distilled}\n\nSources:\n${sourceMap.map((s) => `[S${s.index}] ${s.title}\n${s.url}`).join("\n")}`,
		details: {
			...result,
			distilled: true,
			distillerModel: distiller.model,
			intent: intent || undefined,
			sourceMap,
			readErrors,
		},
	};
}

export function invalidateKbCatalogCache(): void {
	cachedKbCatalogContext = null;
}

export function splitShellLikeArgs(args: string): string[] {
	const result: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(args)) !== null) {
		const token = match[1] ?? match[2] ?? match[3] ?? "";
		if (token.length > 0) result.push(token.replace(/\\(["'\\])/g, "$1"));
	}
	return result;
}

export function getKbIndexUsageText(): string {
	return [
		"Usage:",
		"/kb-index update [--scope project|shared|all] [--source <sourceId>] [--reindex]",
		"/kb-index status",
		"/kb-index clear [--scope project|shared|all] [--source <sourceId>]",
		"",
		"Notes:",
		"- --source can be repeated",
		"- --all is shorthand for --scope all",
	].join("\n");
}

export function parseKbIndexArgs(rawArgs: string): { action: "update" | "status" | "clear"; scope: KbIndexScope; sourceIds: string[]; reindex: boolean } {
	const tokens = splitShellLikeArgs(rawArgs.trim());
	if (tokens.length === 0) throw new Error(getKbIndexUsageText());

	const actionToken = tokens[0];
	if (actionToken !== "update" && actionToken !== "status" && actionToken !== "clear") {
		throw new Error(`Unknown action: ${actionToken}\n\n${getKbIndexUsageText()}`);
	}
	const action = actionToken;
	const startIndex = 1;

	let scope: KbIndexScope = action === "status" ? "all" : "project";
	let reindex = false;
	const sourceIds: string[] = [];

	if (action === "status" && tokens.length > 1) {
		throw new Error(`Unknown argument: ${tokens[1]}\n\n/kb-index status does not accept options and always shows all available indexes.\n\n${getKbIndexUsageText()}`);
	}

	for (let i = startIndex; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--scope") {
			const next = tokens[i + 1];
			if (next !== "project" && next !== "shared" && next !== "all") {
				throw new Error("--scope must be one of: project, shared, all");
			}
			scope = next;
			i += 1;
			continue;
		}
		if (token === "--all") {
			scope = "all";
			continue;
		}
		if (token === "--source") {
			const next = tokens[i + 1];
			if (!next) throw new Error("--source requires a source ID");
			sourceIds.push(next);
			i += 1;
			continue;
		}
		if (token === "--reindex") {
			reindex = true;
			continue;
		}
		throw new Error(`Unknown argument: ${token}\n\n${getKbIndexUsageText()}`);
	}

	return { action, scope, sourceIds, reindex };
}
