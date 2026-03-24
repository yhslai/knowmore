import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

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

interface KnowmoreConfig {
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
const DEFAULT_DISTILLER_MODEL = "google/gemini-2.0-flash-lite-001";

const searchCache = new Map<string, SearchCacheEntry>();
const urlCache = new Map<string, UrlCacheEntry>();

function getDefaultGlobalConfigPath(): string {
	const extensionFile = fileURLToPath(import.meta.url);
	const extensionDir = path.dirname(extensionFile);
	const packageRoot = path.resolve(extensionDir, "..", "..");
	return path.join(packageRoot, "knowmore.config.json");
}

function getGlobalConfigPath(): string {
	const envPath = process.env.KNOWMORE_CONFIG_PATH?.trim();
	if (envPath) return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
	return getDefaultGlobalConfigPath();
}

function findNearestProjectConfigPath(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, "knowmore.config.json");
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

function loadConfig(cwd?: string): { config: KnowmoreConfig; globalConfigPath: string; projectConfigPath: string | null } {
	const globalConfigPath = getGlobalConfigPath();
	if (!fs.existsSync(globalConfigPath)) {
		throw new Error(
			`Global Knowmore config file not found at ${globalConfigPath}. Create it from knowmore.config.example.json and set web.braveApiKey + distiller settings.`,
		);
	}

	let config = readConfigFile(globalConfigPath);
	let projectConfigPath: string | null = null;

	if (cwd) {
		projectConfigPath = findNearestProjectConfigPath(cwd);
		if (projectConfigPath && path.resolve(projectConfigPath) !== path.resolve(globalConfigPath)) {
			const projectConfig = readConfigFile(projectConfigPath);
			config = mergeConfigs(config, projectConfig);
		}
	}

	return { config, globalConfigPath, projectConfigPath };
}

function requireBraveApiKey(config: KnowmoreConfig): string {
	const apiKey = config.web?.braveApiKey;
	if (!apiKey || apiKey.trim().length === 0) {
		throw new Error("web.braveApiKey is missing in knowmore.config.json.");
	}
	return apiKey;
}

function requireDistillerSettings(config: KnowmoreConfig): DistillerSettings {
	const openrouterApiKey = config.distiller?.openrouterApiKey;
	if (!openrouterApiKey || openrouterApiKey.trim().length === 0) {
		throw new Error("distiller.openrouterApiKey is missing in knowmore.config.json.");
	}

	const model = config.distiller?.model ?? DEFAULT_DISTILLER_MODEL;
	if (!model || model.trim().length === 0) {
		throw new Error("distiller.model is missing in knowmore.config.json.");
	}

	return { openrouterApiKey, model };
}

function maskApiKey(apiKey: string): string {
	if (apiKey.length <= 8) return "***";
	return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function stripHtml(html: string): string {
	const noScript = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
	const noTags = noScript.replace(/<[^>]+>/g, " ");
	return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
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
	const cleaned = contentType.includes("text/html") ? stripHtml(raw) : raw.replace(/\s+/g, " ").trim();
	const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim();

	return {
		expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
		content: truncate(cleaned, maxChars),
		title,
	};
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
): Promise<string> {
	const budget = estimateDistillerBudget(query, sources);
	const prompt = [
		"You are a distiller model used by a coding assistant.",
		"Task: distill web evidence into compact, useful context for another model.",
		"Rules:",
		"- Focus on information relevant to the query.",
		"- Prefer concrete facts; avoid speculation.",
		"- If evidence is weak/conflicting, explicitly say so.",
		"- Preserve source references inline like [S1], [S2] where appropriate.",
		"- Do not write a final user-facing answer; write context for another model.",
		`- Keep output around ${budget.wordLimit} words (roughly ±20%, shorter if evidence is sparse).`,
		"",
		`Query: ${query}`,
		"",
		"Sources:",
		...sources.map((s) => `S${s.index}: ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}\nContent: ${s.content}`),
	].join("\n");

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

export default function knowmoreExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "km_search_web",
		label: "KM Search Web",
		description: "Searches the web via Brave Search and returns ranked results with titles, snippets, and URLs.",
		promptSnippet: "Search the web and return ranked results with source URLs.",
		promptGuidelines: [
			"Use km_search_web when user asks for external facts, recent changes, docs, or anything uncertain from local context.",
			"Do not assume web facts without retrieval when confidence is low.",
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
			"Use km_research_web first for external/recent questions to save context.",
			"If distilled context is insufficient, follow specific sources with km_fetch_url.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Research query" }),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 10 })),
			maxCharsPerUrl: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 15000 })),
		}),
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? truncate(args.query, 100) : "";
			const count = typeof args?.count === "number" ? ` count=${args.count}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("km_research_web"))} ${theme.fg("accent", query)}${theme.fg("muted", count)}`, 0, 0);
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
						distillerModel: distiller.model,
						sourceMap: [] as Array<{ index: number; title: string; url: string }>,
						fetchErrors,
						rawResults: searchResults,
						results: searchResults,
					},
				};
			}

			const distilled = await runDistillerModel(distiller, query, sourceInputs, signal);
			const sourceMap = sourceInputs.map((s) => ({ index: s.index, title: s.title, url: s.url }));

			return {
				content: [
					{
						type: "text",
						text: `Distilled web context for: ${query}\n\n${distilled}\n\nSources:\n${sourceMap.map((s) => `[S${s.index}] ${s.title}\n${s.url}`).join("\n")}`,
					},
				],
				details: {
					query,
					distillerModel: distiller.model,
					sourceMap,
					fetchErrors,
					rawResults: searchResults,
					results: searchResults,
				},
			};
		},
	});

	pi.registerCommand("km-diagnose", {
		description: "Validate Knowmore config, Brave search, and distiller model configuration",
		handler: async (args, ctx) => {
			const query = args.trim() || "brave search api";

			const emitDiagnose = (title: string, payload: unknown) => {
				pi.sendMessage({
					customType: "km-diagnose",
					content: `${title}\n${JSON.stringify(payload, null, 2)}`,
					display: true,
					details: payload,
				});
			};

			let loaded: { config: KnowmoreConfig; globalConfigPath: string; projectConfigPath: string | null };
			try {
				loaded = loadConfig(ctx.cwd);
			} catch (error) {
				emitDiagnose("km-diagnose config", {
					cwd: ctx.cwd,
					globalConfig: getGlobalConfigPath(),
					projectConfig: findNearestProjectConfigPath(ctx.cwd),
					error: error instanceof Error ? error.message : String(error),
				});
				ctx.ui.notify(`km-diagnose FAILED | ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const { config, globalConfigPath, projectConfigPath } = loaded;
			const braveRaw = config.web?.braveApiKey;
			const openrouterRaw = config.distiller?.openrouterApiKey;
			const distillerModel = config.distiller?.model ?? DEFAULT_DISTILLER_MODEL;

			emitDiagnose("km-diagnose config", {
				cwd: ctx.cwd,
				globalConfig: globalConfigPath,
				projectConfig: projectConfigPath,
				effective: {
					braveApiKey: braveRaw ? maskApiKey(braveRaw) : null,
					openrouterApiKey: openrouterRaw ? maskApiKey(openrouterRaw) : null,
					distillerModel,
				},
				checks: {
					brave: "pending",
					distiller: "pending",
				},
			});

			try {
				const braveApiKey = requireBraveApiKey(config);
				const distiller = requireDistillerSettings(config);

				const results = await braveWebSearch(braveApiKey, query, 1);
				const top = results[0];
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
					`km-diagnose FAILED | cwd: ${ctx.cwd} | globalConfig: ${globalConfigPath} | projectConfig: ${projectConfigPath ?? "(none)"} | ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});


	pi.registerCommand("km-clear-cache", {
		description: "Clear Knowmore web search and URL caches",
		handler: async (_args, ctx) => {
			searchCache.clear();
			urlCache.clear();
			ctx.ui.notify("Knowmore caches cleared", "info");
		},
	});
}