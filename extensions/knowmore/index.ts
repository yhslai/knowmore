import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
	buildKnowledgeBaseCatalog,
	buildMissingKnowledgeBaseReferencesError,
	ensureKnowledgeBaseReferencesExist,
	getMissingKnowledgeBaseRootDirectories,
	getMissingKnowledgeBaseSources,
	type KnowledgeBaseCatalogResult,
	type KnowmoreKnowledgeBaseConfig,
} from "./kb.js";
import {
	clearKbIndex,
	formatKbIndexStatus,
	formatKbIndexUpdateResult,
	formatKbSearchResult,
	formatKbUnionSearchResult,
	getKbIndexStatus,
	resolveKbIndexPaths,
	searchKbIndex,
	searchKbIndexUnion,
	updateKbIndex,
	type KbIndexScope,
} from "./kb-index.js";
import { looksLikeHtmlDocument, preprocessDocumentTextForDistiller } from "./content-cleaning.js";

interface BraveSearchResult {
	title: string;
	url: string;
	description: string;
	age?: string;
}

interface BraveWebSearchItem {
	title?: string;
	url?: string;
	description?: string;
	extra_snippets?: string[];
	age?: string;
	page_age?: string;
}

interface BraveSearchResponse {
	web?: {
		results?: BraveWebSearchItem[];
	};
}

interface SearchCacheEntry {
	expiresAt: number;
	results: BraveSearchResult[];
}

interface UrlCacheEntry {
	expiresAt: number;
	content: string;
	title?: string;
}

interface DistillerSettings {
	openrouterApiKey: string;
	model: string;
}

interface KnowmoreConfig extends KnowmoreKnowledgeBaseConfig {
	KB_INDEX_DIR?: string;
	web?: {
		braveApiKey?: string;
	};
	distiller?: {
		openrouterApiKey?: string;
		model?: string;
	};
}


const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const GLOBAL_CONFIG_DEFAULT_FILE = "knowmore.config.default.json";
const PROJECT_CONFIG_FILE = "knowmore.config.json";

const searchCache = new Map<string, SearchCacheEntry>();
const urlCache = new Map<string, UrlCacheEntry>();

const KB_CATALOG_PROMPT_START = "<!-- knowmore:kb-catalog:start -->";
const KB_CATALOG_PROMPT_END = "<!-- knowmore:kb-catalog:end -->";

interface PromptKbSourceEntry {
	id: string;
	description?: string;
}

interface CachedKbCatalogContext {
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

function getPackageRootPath(): string {
	const extensionFile = fileURLToPath(import.meta.url);
	const extensionDir = path.dirname(extensionFile);
	return path.resolve(extensionDir, "..", "..");
}

function getDefaultGlobalConfigPath(): string {
	return path.join(getPackageRootPath(), GLOBAL_CONFIG_DEFAULT_FILE);
}


function getGlobalConfigPath(): string | null {
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

function findNearestProjectConfigPath(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, PROJECT_CONFIG_FILE);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function readConfigFile(configPath: string): KnowmoreConfig {
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

function mergeConfigs(baseConfig: KnowmoreConfig, overrideConfig: KnowmoreConfig): KnowmoreConfig {
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

function loadConfig(cwd?: string): { config: KnowmoreConfig; globalConfigPath: string | null; projectConfigPath: string | null } {
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

function requireBraveApiKey(config: KnowmoreConfig): string {
	const apiKey = config.web?.braveApiKey;
	if (!apiKey || apiKey.trim().length === 0) {
		throw new Error("web.braveApiKey is missing in effective Knowmore config.");
	}
	return apiKey;
}

function requireDistillerSettings(config: KnowmoreConfig): DistillerSettings {
	const openrouterApiKey = config.distiller?.openrouterApiKey;
	if (!openrouterApiKey || openrouterApiKey.trim().length === 0) {
		throw new Error("distiller.openrouterApiKey is missing in effective Knowmore config.");
	}

	const model = config.distiller?.model;
	if (!model || model.trim().length === 0) {
		throw new Error("distiller.model is missing in effective Knowmore config.");
	}

	return { openrouterApiKey, model };
}

function maskApiKey(apiKey: string): string {
	if (apiKey.length <= 8) return "***";
	return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const textBlock = result.content.find((block) => block.type === "text");
	if (!textBlock || typeof textBlock.text !== "string") return "";
	return textBlock.text;
}

function renderCollapsedSummary(theme: any, summary: string): Text {
	return new Text(`${theme.fg("toolOutput", summary)} ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`, 0, 0);
}

function renderExpandedText(result: { content: Array<{ type: string; text?: string }> }, theme: any): Text {
	const text = getResultText(result);
	if (!text) return new Text("", 0, 0);
	return new Text(`\n${text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n")}`, 0, 0);
}

function getSearchResultSummary(details: any): string {
	const query = typeof details?.query === "string" ? details.query : "(unknown query)";
	const source = details?.source === "cache" ? "cache" : "network";
	const resultCount = Array.isArray(details?.results) ? details.results.length : 0;
	return `${resultCount} result${resultCount === 1 ? "" : "s"} for \"${truncate(query, 80)}\" (${source})`;
}

function getFetchUrlSummary(details: any): string {
	const source = details?.source === "cache" ? "cache" : "network";
	const url = typeof details?.url === "string" ? details.url : "(unknown URL)";
	const title = typeof details?.title === "string" && details.title.trim() ? ` — ${truncate(details.title.trim(), 80)}` : "";
	return `Fetched ${truncate(url, 100)}${title} (${source})`;
}

function getResearchSummary(details: any): string {
	const query = typeof details?.query === "string" ? details.query : "(unknown query)";
	const sourceCount = Array.isArray(details?.sourceMap) ? details.sourceMap.length : 0;
	const errorCount = Array.isArray(details?.fetchErrors) ? details.fetchErrors.length : 0;
	const suffix = errorCount > 0 ? `, ${errorCount} fetch error${errorCount === 1 ? "" : "s"}` : "";
	return `Distilled \"${truncate(query, 80)}\" from ${sourceCount} source${sourceCount === 1 ? "" : "s"}${suffix}`;
}

function getKbSearchSummary(details: any): string {
	const query = typeof details?.query === "string" ? details.query : "(unknown query)";
	const resultCount = Array.isArray(details?.results) ? details.results.length : 0;
	return `${resultCount} local KB match${resultCount === 1 ? "" : "es"} for \"${truncate(query, 80)}\"`;
}

function getKbUnionSearchSummary(details: any): string {
	const allCount = Array.isArray(details?.all) ? details.all.length : 0;
	const anyCount = Array.isArray(details?.any) ? details.any.length : 0;
	const resultCount = Array.isArray(details?.results) ? details.results.length : 0;
	const distilled = details?.distilled ? " (distilled)" : "";
	return `${resultCount} KB union match${resultCount === 1 ? "" : "es"} for all=${allCount}, any=${anyCount}${distilled}`;
}

function splitShellLikeArgs(args: string): string[] {
	const result: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(args)) !== null) {
		const token = match[1] ?? match[2] ?? match[3] ?? "";
		if (token.length > 0) result.push(token.replace(/\\(["'\\])/g, "$1"));
	}
	return result;
}

function getKbIndexUsageText(): string {
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

function parseKbIndexArgs(rawArgs: string): { action: "update" | "status" | "clear"; scope: KbIndexScope; sourceIds: string[]; reindex: boolean } {
	const tokens = splitShellLikeArgs(rawArgs.trim());
	if (tokens.length === 0) throw new Error(getKbIndexUsageText());

	const actionToken = tokens[0];
	if (actionToken !== "update" && actionToken !== "status" && actionToken !== "clear") {
		throw new Error(`Unknown action: ${actionToken}\n\n${getKbIndexUsageText()}`);
	}
	const action = actionToken;
	const startIndex = 1;

	let scope: KbIndexScope = "project";
	let reindex = false;
	const sourceIds: string[] = [];

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

function validateKbIndexSourceIds(catalog: KnowledgeBaseCatalogResult, scope: KbIndexScope, sourceIds?: string[]): void {
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

function buildPromptKbSources(catalog: KnowledgeBaseCatalogResult): PromptKbSourceEntry[] {
	const maxSourcesInPrompt = 120;
	return catalog.sources.slice(0, maxSourcesInPrompt).map((source) => ({
		id: source.id,
		description: source.description,
	}));
}

function buildKbCatalogPromptInjection(promptSources: PromptKbSourceEntry[], totalSources: number): string {
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
	lines.push(KB_CATALOG_PROMPT_END);
	return lines.join("\n");
}

function stripInjectedKbCatalogPrompt(systemPrompt: string): string {
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

function getCachedKbCatalogContextForCwd(cwd: string): CachedKbCatalogContext | null {
	const resolvedCwd = path.resolve(cwd);
	if (!cachedKbCatalogContext) return null;
	if (cachedKbCatalogContext.cwd !== resolvedCwd) return null;
	return cachedKbCatalogContext;
}

function buildAndCacheKbCatalogContext(cwd: string, loaded?: { config: KnowmoreConfig; globalConfigPath: string | null; projectConfigPath: string | null }): CachedKbCatalogContext {
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

function getOrBuildKbCatalogContext(cwd: string): { context: CachedKbCatalogContext; cacheHit: boolean } {
	const cached = getCachedKbCatalogContextForCwd(cwd);
	if (cached) return { context: cached, cacheHit: true };
	return { context: buildAndCacheKbCatalogContext(cwd), cacheHit: false };
}

function getSearchCacheKey(query: string, count: number): string {
	return `${query}\u0000${count}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
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

function asTrimmedString(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
}

function normalizeWebResult(item: BraveWebSearchItem): BraveSearchResult | null {
	const url = asTrimmedString(item.url);
	if (!url) return null;

	const title = asTrimmedString(item.title) || url;
	const description = asTrimmedString(item.description) || asTrimmedString(item.extra_snippets?.[0]) || "";
	const age = asTrimmedString(item.age) || asTrimmedString(item.page_age);
	return { title, url, description, age };
}

async function braveWebSearch(apiKey: string, query: string, count: number, signal?: AbortSignal): Promise<BraveSearchResult[]> {
	const params = new URLSearchParams({
		q: query,
		count: String(count),
		search_lang: "en",
	});

	const response = await fetchWithTimeout(
		`${BRAVE_SEARCH_URL}?${params.toString()}`,
		{
			method: "GET",
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": apiKey,
			},
		},
		DEFAULT_TIMEOUT_MS,
		signal,
	);

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Brave search failed (${response.status}): ${truncate(body, 300)}`);
	}

	const payload = (await response.json()) as BraveSearchResponse;
	const candidates = payload.web?.results ?? [];

	const normalized = candidates.map((item) => normalizeWebResult(item)).filter((item): item is BraveSearchResult => item !== null);

	const deduped: BraveSearchResult[] = [];
	const seen = new Set<string>();
	for (const item of normalized) {
		if (seen.has(item.url)) continue;
		seen.add(item.url);
		deduped.push(item);
		if (deduped.length >= count) break;
	}

	return deduped;
}

async function fetchUrlContent(url: string, maxChars: number, signal?: AbortSignal): Promise<UrlCacheEntry> {
	const response = await fetchWithTimeout(
		url,
		{
			method: "GET",
			headers: {
				"User-Agent": "knowmore/0.1 (+pi extension)",
				Accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
			},
		},
		DEFAULT_TIMEOUT_MS,
		signal,
	);

	if (!response.ok) {
		throw new Error(`URL fetch failed (${response.status}) for ${url}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	const raw = await response.text();
	const cleaned = preprocessDocumentTextForDistiller(raw, { contentType });
	const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim();

	return {
		expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
		content: truncate(cleaned, maxChars),
		title,
	};
}

function readLocalChunkContext(
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

interface DistillerSourceInput {
	index: number;
	title: string;
	url: string;
	snippet: string;
	content: string;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function estimateDistillerBudget(query: string, sources: DistillerSourceInput[]): { wordLimit: number; maxTokens: number } {
	const totalInputChars =
		query.length +
		sources.reduce((sum, source) => sum + source.title.length + source.url.length + source.snippet.length + source.content.length, 0);

	const wordLimit = clamp(Math.round(totalInputChars / 20), 300, 4000);
	const maxTokens = clamp(Math.ceil(wordLimit * 1.8), 320, 4096);
	return { wordLimit, maxTokens };
}

async function runDistillerModel(
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

// noinspection JSUnusedGlobalSymbols
export default function knowmoreExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const baseSystemPrompt = stripInjectedKbCatalogPrompt(event.systemPrompt);
		try {
			const { context } = getOrBuildKbCatalogContext(ctx.cwd);
			ensureKnowledgeBaseReferencesExist(context.catalog);
			const systemPrompt = `${baseSystemPrompt}\n\n${context.promptInjection}`.trim();
			return { systemPrompt };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				systemPrompt: baseSystemPrompt,
				message: {
					customType: "knowmore-warning",
					content: `Knowmore could not inject KB catalog: ${message}`,
					display: true,
					details: { cwd: ctx.cwd, error: message },
				},
			};
		}
	});


	pi.registerTool({
		name: "kb_search",
		label: "KB Search",
		description: "Searches local indexed knowledge-base chunks. Doesn't support semantic retrieval, only lexical ranking (BM25).",
		promptSnippet: "Search the local KB index for exact terms, symbols, and matching passages.",
		promptGuidelines: [
            "This only matches exact words, so keep the query concise and broad.",
            "Unless you know the exact term precisely, use kb_union_search with a broader query instead might be a good idea.",
            "If it doesn't find what you need, try a broader (shorter) query or some synonyms or try kb_union_search instead.",
            "If you find a chunk that's relevant but insufficient, follow up with a direct read of the source file for more context."
		],
		parameters: Type.Object({
			query: Type.String({ description: "Lexical search query" }),
			sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional source IDs to scope search" })),
			topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 8 })),
			pathPrefix: Type.Optional(Type.String({ description: "Optional absolute path prefix filter" })),
		}),
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? truncate(args.query, 100) : "";
			const topK = typeof args?.topK === "number" ? ` topK=${args.topK}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("kb_search"))} ${theme.fg("accent", query)}${theme.fg("muted", topK)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return renderCollapsedSummary(theme, getKbSearchSummary(result.details));
			return renderExpandedText(result, theme);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { context } = getOrBuildKbCatalogContext(ctx.cwd);
			ensureKnowledgeBaseReferencesExist(context.catalog);
			validateKbIndexSourceIds(context.catalog, "all", params.sourceIds);
			const paths = resolveKbIndexPaths(ctx.cwd, context.loaded.projectConfigPath, context.loaded.config.KB_INDEX_DIR);
			const result = searchKbIndex(paths.dbPath, {
				query: params.query,
				topK: params.topK ?? 8,
				sourceIds: params.sourceIds,
				pathPrefix: params.pathPrefix,
			});

			return {
				content: [{ type: "text", text: formatKbSearchResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "kb_union_search",
		label: "KB Union Search",
		description:
			"Searches local indexed KB chunks using structured ALL + ANY query. Optionally distills expanded local file contexts in one call.",
		promptSnippet: "Run local KB OR-union retrieval with optional one-shot distillation.",
		promptGuidelines: [
            "If you know the exact term precisely, use kb_search instead for more precise results.",
			"If you don't know the precise terms, you might put synonyms or related terms in any[] for broader coverage.",
			"Set distill=true when you want distilled context from local chunk neighborhoods. If distill=false, returns raw chunks.",
			"Use intent when you want to guide the distiller on what to prioritize (e.g., constraints, comparison criteria, output focus).",
		],
		parameters: Type.Object({
			all: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Required clauses; every clause must match." }),
			any: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional OR clauses; at least one matches when provided." })),
			sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional source IDs to scope search" })),
			topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
			pathPrefix: Type.Optional(Type.String({ description: "Optional absolute path prefix filter" })),
			distill: Type.Optional(Type.Boolean({ default: true, description: "If true, expand local context and distill before returning." })),
			intent: Type.Optional(Type.String({ description: "Optional distillation intent to guide what evidence should be prioritized." })),
			maxChunksToDistill: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 20 })),
			maxCharsPerChunk: Type.Optional(Type.Integer({ minimum: 400, maximum: 12000, default: 5000 })),
		}),
		renderCall(args, theme) {
			const all = Array.isArray(args?.all) ? args.all.length : 0;
			const any = Array.isArray(args?.any) ? args.any.length : 0;
			const topK = typeof args?.topK === "number" ? ` topK=${args.topK}` : "";
			const distill = args?.distill ? " distill" : "";
			const intent = typeof args?.intent === "string" && args.intent.trim().length > 0 ? " intent" : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("kb_union_search"))} ${theme.fg("accent", `all=${all}, any=${any}`)}${theme.fg("muted", `${topK}${distill}${intent}`)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return renderCollapsedSummary(theme, getKbUnionSearchSummary(result.details));
			return renderExpandedText(result, theme);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { context } = getOrBuildKbCatalogContext(ctx.cwd);
			ensureKnowledgeBaseReferencesExist(context.catalog);
			validateKbIndexSourceIds(context.catalog, "all", params.sourceIds);
			const paths = resolveKbIndexPaths(ctx.cwd, context.loaded.projectConfigPath, context.loaded.config.KB_INDEX_DIR);
			const result = searchKbIndexUnion(paths.dbPath, {
				all: params.all,
				any: params.any,
				topK: params.topK ?? 20,
				sourceIds: params.sourceIds,
				pathPrefix: params.pathPrefix,
			});

			if (!params.distill) {
				return {
					content: [{ type: "text", text: formatKbUnionSearchResult(result) }],
					details: { ...result, distilled: false },
				};
			}

			if (result.results.length === 0) {
				return {
					content: [{ type: "text", text: formatKbUnionSearchResult(result) }],
					details: { ...result, distilled: false },
				};
			}

			const { config } = loadConfig(ctx.cwd);
			const distiller = requireDistillerSettings(config);
			const maxChunksToDistill = params.maxChunksToDistill ?? 20;
			const maxCharsPerChunk = params.maxCharsPerChunk ?? 5000;

			const selected = result.results.slice(0, maxChunksToDistill);
			const sourceInputs: DistillerSourceInput[] = [];
			const readErrors: Array<{ filePath: string; error: string }> = [];

			for (let i = 0; i < selected.length; i++) {
				const item = selected[i];
				const contextRead = readLocalChunkContext(
					item.filePath,
					item.startLine,
					item.endLine,
					maxCharsPerChunk,
				);
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

			const distillQuery = `Local KB union search. ALL: ${result.all.join(", ")}${result.any.length > 0 ? ` | ANY: ${result.any.join(" | ")}` : ""}`;
			const distilled = await runDistillerModel(distiller, distillQuery, sourceInputs, signal, params.intent);
			const sourceMap = sourceInputs.map((s) => ({ index: s.index, title: s.title, url: s.url }));

			return {
				content: [
					{
						type: "text",
						text: `Distilled local KB union context\nALL: ${result.all.join(", ")}${result.any.length > 0 ? `\nANY: ${result.any.join(" | ")}` : ""}${typeof params.intent === "string" && params.intent.trim().length > 0 ? `\nIntent: ${params.intent.trim()}` : ""}\n\n${distilled}\n\nSources:\n${sourceMap.map((s) => `[S${s.index}] ${s.title}\n${s.url}`).join("\n")}`,
					},
				],
				details: {
					...result,
					distilled: true,
					distillerModel: distiller.model,
					intent: typeof params.intent === "string" ? params.intent.trim() : undefined,
					sourceMap,
					readErrors,
				},
			};
		},
	});

	pi.registerTool({
		name: "km_search_web",
		label: "KM Search Web",
		description: "Searches the web via Brave Search and returns ranked results with titles, snippets, and URLs.",
		promptSnippet: "Search the web and return ranked results with source URLs.",
		promptGuidelines: [
			"Use km_search_web when user asks for external facts, recent changes, docs, or anything uncertain from local context.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
		}),
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? truncate(args.query, 100) : "";
			const count = typeof args?.count === "number" ? ` count=${args.count}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("km_search_web"))} ${theme.fg("accent", query)}${theme.fg("muted", count)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return renderCollapsedSummary(theme, getSearchResultSummary(result.details));
			return renderExpandedText(result, theme);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { config } = loadConfig(ctx.cwd);
			const apiKey = requireBraveApiKey(config);
			const query = params.query.trim();
			if (query.length === 0) throw new Error("query must not be empty");

			const count = params.count ?? 5;
			const cacheKey = getSearchCacheKey(query, count);
			const cached = searchCache.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				const lines = cached.results.map((item, index) => {
					const ageText = item.age ? ` (${item.age})` : "";
					return `${index + 1}. ${item.title}${ageText}\nURL: ${item.url}\nSnippet: ${item.description}`;
				});
				return {
					content: [{ type: "text", text: `Cached web search results for: ${query}\n\n${lines.join("\n\n")}` }],
					details: { query, count, source: "cache", results: cached.results },
				};
			}

			const results = await braveWebSearch(apiKey, query, count, signal);
			searchCache.set(cacheKey, { expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS, results });

			const lines = results.map((item, index) => {
				const ageText = item.age ? ` (${item.age})` : "";
				return `${index + 1}. ${item.title}${ageText}\nURL: ${item.url}\nSnippet: ${item.description}`;
			});

			return {
				content: [{ type: "text", text: results.length === 0 ? `No web results found for: ${query}` : `Web search results for: ${query}\n\n${lines.join("\n\n")}` }],
				details: { query, count, source: "network", results },
			};
		},
	});

	pi.registerTool({
		name: "km_fetch_url",
		label: "KM Fetch URL",
		description: "Fetches and extracts readable text from a URL. Use this after km_search_web for deeper context.",
		promptSnippet: "Fetch and extract readable text from a URL.",
		promptGuidelines: [
			"Use km_fetch_url only for top relevant URLs; avoid fetching many pages at once.",
			"Keep extracted context concise and cite the source URL in your final answer.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute URL to fetch" }),
			maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 20000, default: 5000 })),
		}),
		renderCall(args, theme) {
			const url = typeof args?.url === "string" ? truncate(args.url, 120) : "";
			const maxChars = typeof args?.maxChars === "number" ? ` maxChars=${args.maxChars}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("km_fetch_url"))} ${theme.fg("accent", url)}${theme.fg("muted", maxChars)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return renderCollapsedSummary(theme, getFetchUrlSummary(result.details));
			return renderExpandedText(result, theme);
		},
		async execute(_toolCallId, params, signal) {
			const url = params.url.trim();
			if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");

			const maxChars = params.maxChars ?? 5000;
			const cached = urlCache.get(url);
			if (cached && cached.expiresAt > Date.now()) {
				return {
					content: [{ type: "text", text: `Cached URL content for ${url}${cached.title ? `\nTitle: ${cached.title}` : ""}\n\n${cached.content}` }],
					details: { url, source: "cache", title: cached.title, content: cached.content },
				};
			}

			const fetched = await fetchUrlContent(url, maxChars, signal);
			urlCache.set(url, fetched);
			return {
				content: [{ type: "text", text: `Fetched URL content for ${url}${fetched.title ? `\nTitle: ${fetched.title}` : ""}\n\n${fetched.content}` }],
				details: { url, source: "network", title: fetched.title, content: fetched.content },
			};
		},
	});

	pi.registerTool({
		name: "km_research_web",
		label: "KM Research Web",
		description:
			"End-to-end web research: searches via Brave, fetches top pages, then uses a distiller model (OpenRouter) to return compact context for the main model.",
		promptSnippet: "Research web evidence efficiently without sending full raw pages to the main model.",
		promptGuidelines: [
			"If distilled context is insufficient, follow specific sources with km_fetch_url.",
            "Stop once you got enough information, no need to over research.",
			"Use intent to steer the distiller toward the exact decision criteria or deliverable you need.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Research query" }),
			intent: Type.Optional(Type.String({ description: "Optional distillation intent to guide what evidence should be prioritized." })),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 10 })),
			maxCharsPerUrl: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 15000 })),
		}),
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? truncate(args.query, 100) : "";
			const count = typeof args?.count === "number" ? ` count=${args.count}` : "";
			const intent = typeof args?.intent === "string" && args.intent.trim().length > 0 ? " intent" : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("km_research_web"))} ${theme.fg("accent", query)}${theme.fg("muted", `${count}${intent}`)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return renderCollapsedSummary(theme, getResearchSummary(result.details));
			return renderExpandedText(result, theme);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (query.length === 0) throw new Error("query must not be empty");

			const { config } = loadConfig(ctx.cwd);
			const braveApiKey = requireBraveApiKey(config);
			const distiller = requireDistillerSettings(config);

			const count = params.count ?? 10;
			const maxCharsPerUrl = params.maxCharsPerUrl ?? 15000;

			const searchResults = await braveWebSearch(braveApiKey, query, count, signal);

			const sourceInputs: DistillerSourceInput[] = [];
			const fetchErrors: Array<{ url: string; error: string }> = [];

			for (let i = 0; i < searchResults.length; i++) {
				const r = searchResults[i];
				try {
					let content = "";
					const cached = urlCache.get(r.url);
					if (cached && cached.expiresAt > Date.now()) {
						content = cached.content;
					} else {
						const fetched = await fetchUrlContent(r.url, maxCharsPerUrl, signal);
						urlCache.set(r.url, fetched);
						content = fetched.content;
					}

					sourceInputs.push({
						index: i + 1,
						title: r.title,
						url: r.url,
						snippet: truncate(r.description, 600),
						content,
					});
				} catch (error) {
					fetchErrors.push({ url: r.url, error: error instanceof Error ? error.message : String(error) });
				}
			}

			if (sourceInputs.length === 0) {
				return {
					content: [{ type: "text", text: `No fetchable sources found for: ${query}` }],
					details: {
						query,
						intent: typeof params.intent === "string" ? params.intent.trim() : undefined,
						distillerModel: distiller.model,
						sourceMap: [] as Array<{ index: number; title: string; url: string }>,
						fetchErrors,
						rawResults: searchResults,
						results: searchResults,
					},
				};
			}

			const distilled = await runDistillerModel(distiller, query, sourceInputs, signal, params.intent);
			const sourceMap = sourceInputs.map((s) => ({ index: s.index, title: s.title, url: s.url }));

			return {
				content: [
					{
						type: "text",
						text: `Distilled web context for: ${query}${typeof params.intent === "string" && params.intent.trim().length > 0 ? `\nIntent: ${params.intent.trim()}` : ""}\n\n${distilled}\n\nSources:\n${sourceMap.map((s) => `[S${s.index}] ${s.title}\n${s.url}`).join("\n")}`,
					},
				],
				details: {
					query,
					intent: typeof params.intent === "string" ? params.intent.trim() : undefined,
					distillerModel: distiller.model,
					sourceMap,
					fetchErrors,
					rawResults: searchResults,
					results: searchResults,
				},
			};
		},
	});

	pi.registerCommand("kb-index", {
		description: "Manage local KB index. Usage: /kb-index <update|status|clear> [--scope project|shared|all] [--source <id>] [--reindex]",
		handler: async (args, ctx) => {
			let parsed: { action: "update" | "status" | "clear"; scope: KbIndexScope; sourceIds: string[]; reindex: boolean };
			try {
				parsed = parseKbIndexArgs(args);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				pi.sendMessage({
					customType: "kb-index-usage",
					content: message,
					display: true,
					details: { args, error: message },
				});
				ctx.ui.notify("kb-index usage shown", "info");
				return;
			}

			let loaded: { config: KnowmoreConfig; globalConfigPath: string | null; projectConfigPath: string | null };
			try {
				loaded = loadConfig(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(`kb-index FAILED | ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const indexPaths = resolveKbIndexPaths(ctx.cwd, loaded.projectConfigPath, loaded.config.KB_INDEX_DIR);
			const sourceIds = parsed.sourceIds.length > 0 ? parsed.sourceIds : undefined;

			const kbIndexStatusKey = "knowmore.kb-index";

			try {
				if (parsed.action === "status") {
					const status = getKbIndexStatus(indexPaths.dbPath);
					pi.sendMessage({
						customType: "kb-index-status",
						content: formatKbIndexStatus(status),
						display: true,
						details: status,
					});
					ctx.ui.notify(`kb-index OK | status | ${indexPaths.dbPath}`, "info");
					return;
				}

				if (parsed.action === "clear") {
					if (sourceIds && sourceIds.length > 0) {
						const kbCatalogForValidation = buildKnowledgeBaseCatalog(loaded.config, {
							globalConfigPath: loaded.globalConfigPath,
							projectConfigPath: loaded.projectConfigPath,
						});
						validateKbIndexSourceIds(kbCatalogForValidation, parsed.scope, sourceIds);
					}
					const cleared = clearKbIndex(indexPaths.dbPath, parsed.scope, sourceIds);
					const clearedSummary =
						cleared.clearedSources.length === 0
							? "none"
							: cleared.clearedSources[0] === "*"
								? "all"
								: `${cleared.clearedSources.length} source(s)`;
					pi.sendMessage({
						customType: "kb-index-clear",
						content: `KB index cleared (${clearedSummary})\nDB: \`${cleared.dbPath}\``,
						display: true,
						details: cleared,
					});
					ctx.ui.notify(`kb-index OK | clear | ${clearedSummary}`, "info");
					return;
				}

				const kbCatalog = buildKnowledgeBaseCatalog(loaded.config, {
					globalConfigPath: loaded.globalConfigPath,
					projectConfigPath: loaded.projectConfigPath,
				});
				ensureKnowledgeBaseReferencesExist(kbCatalog);
				validateKbIndexSourceIds(kbCatalog, parsed.scope, sourceIds);

				ctx.ui.setStatus(kbIndexStatusKey, "kb-index: preparing sources...");
				const updated = await updateKbIndex(indexPaths.dbPath, kbCatalog, {
					scope: parsed.scope,
					sourceIds,
					reindex: parsed.reindex,
					onSourceStart: (event) => {
						pi.sendMessage({
							customType: "kb-index-progress",
							content: `Indexing source ${event.sourceIndex}/${event.totalSources}: \`${event.sourceId}\`\nPath: \`${event.sourcePath}\``,
							display: true,
							details: event,
						});
					},
					onFileProgress: (event) => {
						const action = event.phase === "remove" ? "removing" : "indexing";
						ctx.ui.setStatus(
							kbIndexStatusKey,
							`kb-index: ${event.sourceId} | ${action} ${event.fileIndex}/${event.totalFiles} | ${path.basename(event.filePath)}`,
						);
					},
				});
				pi.sendMessage({
					customType: "kb-index-update",
					content: formatKbIndexUpdateResult(updated),
					display: true,
					details: updated,
				});
				ctx.ui.notify(`kb-index OK | updated ${updated.sources.length} source(s) | ${indexPaths.dbPath}`, "info");
			} catch (error) {
				ctx.ui.notify(`kb-index FAILED | ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus(kbIndexStatusKey, undefined);
			}
		},
	});

	pi.registerCommand("km-diagnose", {
		description: "Validate Knowmore config, local KB discovery, Brave search, and distiller model configuration",
		handler: async (args, ctx) => {
			const query = args.trim() || "brave search api";
			const diagnoseStatusKey = "knowmore.km-diagnose";
			const statusFrames = [".", "..", "..."];
			let statusFrameIndex = 0;
			let statusStage = "initializing";
			let statusTimer: ReturnType<typeof setInterval> | null = null;

			const renderDiagnoseStatus = () => {
				const frame = statusFrames[statusFrameIndex % statusFrames.length];
				ctx.ui.setStatus(diagnoseStatusKey, `km-diagnose: running (${statusStage}${frame})`);
			};

			const startDiagnoseStatus = (stage: string) => {
				statusStage = stage;
				statusFrameIndex = 0;
				renderDiagnoseStatus();
				if (statusTimer !== null) return;
				statusTimer = setInterval(() => {
					statusFrameIndex = (statusFrameIndex + 1) % statusFrames.length;
					renderDiagnoseStatus();
				}, 350);
			};

			const stopDiagnoseStatus = () => {
				if (statusTimer !== null) {
					clearInterval(statusTimer);
					statusTimer = null;
				}
				ctx.ui.setStatus(diagnoseStatusKey, undefined);
			};

			const emitDiagnose = (title: string, payload: unknown) => {
				pi.sendMessage({
					customType: "km-diagnose",
					content: `${title}\n${JSON.stringify(payload, null, 2)}`,
					display: true,
					details: payload,
				});
			};

			let loaded: { config: KnowmoreConfig; globalConfigPath: string | null; projectConfigPath: string | null };
			try {
				loaded = loadConfig(ctx.cwd);
			} catch (error) {
				let globalConfig: string | null = null;
				let globalConfigError: string | null = null;
				try {
					globalConfig = getGlobalConfigPath();
				} catch (probeError) {
					globalConfigError = probeError instanceof Error ? probeError.message : String(probeError);
				}

				emitDiagnose("km-diagnose config", {
					cwd: ctx.cwd,
					globalConfig,
					globalConfigError,
					projectConfig: findNearestProjectConfigPath(ctx.cwd),
					error: error instanceof Error ? error.message : String(error),
				});
				ctx.ui.notify(`km-diagnose FAILED | ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const { config, globalConfigPath, projectConfigPath } = loaded;
			const kbIndexPaths = resolveKbIndexPaths(ctx.cwd, projectConfigPath, config.KB_INDEX_DIR);
			const braveRaw = config.web?.braveApiKey;
			const openrouterRaw = config.distiller?.openrouterApiKey;
			const distillerModel = config.distiller?.model;
			const existingCache = getCachedKbCatalogContextForCwd(ctx.cwd);
			const kbContext = existingCache ?? buildAndCacheKbCatalogContext(ctx.cwd, loaded);
			const kbCatalog = kbContext.catalog;
			const missingKbRoots = getMissingKnowledgeBaseRootDirectories(kbCatalog);
			const missingKbSources = getMissingKnowledgeBaseSources(kbCatalog);
			const missingKbReferencesError = buildMissingKnowledgeBaseReferencesError(kbCatalog);
			const sourcePreviewLimit = 50;
			const sourcePreview = kbContext.promptSources.slice(0, sourcePreviewLimit);

			emitDiagnose("km-diagnose config", {
				cwd: ctx.cwd,
				globalConfig: globalConfigPath,
				projectConfig: projectConfigPath,
				effective: {
					braveApiKey: braveRaw ? maskApiKey(braveRaw) : null,
					openrouterApiKey: openrouterRaw ? maskApiKey(openrouterRaw) : null,
					distillerModel,
					kbIndexDir: config.KB_INDEX_DIR ?? null,
					kbIndexResolvedDir: kbIndexPaths.indexDir,
					kbIndexDbPath: kbIndexPaths.dbPath,
				},
				kbCache: {
					hit: !!existingCache,
					computedAt: new Date(kbContext.computedAt).toISOString(),
					ageMs: Date.now() - kbContext.computedAt,
				},
				kb: {
					rootIds: kbCatalog.roots.map((root) => root.id),
					sources: sourcePreview,
					sourceTotal: kbCatalog.sources.length,
					sourcesTruncated: kbCatalog.sources.length > sourcePreview.length,
					warningCount: kbCatalog.warnings.length,
				},
				checks: {
					kbRoots: missingKbRoots.length === 0 ? "ok" : { status: "failed", missing: missingKbRoots },
					kbSources: missingKbSources.length === 0 ? "ok" : { status: "failed", missing: missingKbSources },
					brave: "pending",
					distiller: "pending",
				},
			});

			if (missingKbReferencesError) {
				emitDiagnose("km-diagnose result", {
					status: "failed",
					query,
					checks: {
						kbRoots: missingKbRoots.length === 0 ? "ok" : { status: "failed", missing: missingKbRoots },
						kbSources: missingKbSources.length === 0 ? "ok" : { status: "failed", missing: missingKbSources },
						brave: "skipped",
						distiller: "skipped",
					},
					error: missingKbReferencesError,
				});
				ctx.ui.notify(
					`km-diagnose FAILED | cwd: ${ctx.cwd} | globalConfig: ${globalConfigPath ?? "(none)"} | projectConfig: ${projectConfigPath ?? "(none)"} | ${missingKbReferencesError}`,
					"error",
				);
				return;
			}

			try {
				const braveApiKey = requireBraveApiKey(config);
				const distiller = requireDistillerSettings(config);

				startDiagnoseStatus("checking Brave API");
				const results = await braveWebSearch(braveApiKey, query, 1);
				const top = results[0];

				startDiagnoseStatus("checking distiller API");
				const distillerProbe = await runDistillerModel(
					distiller,
					"Return exactly the word OK.",
					[
						{
							index: 1,
							title: "Probe",
							url: "https://example.com",
							snippet: "probe",
							content: "probe",
						},
					],
				);

				emitDiagnose("km-diagnose result", {
					status: "ok",
					query,
					checks: {
						brave: { status: "ok", results: results.length, topUrl: top?.url ?? null },
						distiller: { status: "ok", probe: truncate(distillerProbe, 40) },
					},
				});

				ctx.ui.notify(
					`km-diagnose OK | results: ${results.length}${top ? ` | top: ${top.url}` : ""} | distillerProbe: ${truncate(distillerProbe, 40)}`,
					"info",
				);
			} catch (error) {
				emitDiagnose("km-diagnose result", {
					status: "failed",
					query,
					checks: {
						brave: "ran",
						distiller: "ran",
						error: error instanceof Error ? error.message : String(error),
					},
				});
				ctx.ui.notify(
					`km-diagnose FAILED | cwd: ${ctx.cwd} | globalConfig: ${globalConfigPath ?? "(none)"} | projectConfig: ${projectConfigPath ?? "(none)"} | ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				stopDiagnoseStatus();
			}
		},
	});


	pi.registerCommand("km-clear-cache", {
		description: "Clear Knowmore web search, URL, and KB catalog caches",
		handler: async (_args, ctx) => {
			searchCache.clear();
			urlCache.clear();
			cachedKbCatalogContext = null;
			ctx.ui.notify("Knowmore caches cleared", "info");
		},
	});
}