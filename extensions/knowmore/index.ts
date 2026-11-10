import * as fs from "node:fs";
import * as path from "node:path";
import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
	buildKnowledgeBaseCatalog,
	buildMissingKnowledgeBaseReferencesError,
	ensureKnowledgeBaseReferencesExist,
	getMissingKnowledgeBaseRootDirectories,
	getMissingKnowledgeBaseSources,
} from "./kb.js";
import {
	clearKbIndex,
	formatKbIndexStatus,
	formatKbIndexUpdateResult,
	getKbIndexStatus,
	pickKbIndexPath,
	resolveKbIndexPaths,
	updateKbIndex,
	type KbIndexScope,
} from "./kb-index.js";
import { preprocessDocumentTextForDistiller } from "./content-cleaning.js";
import {
	DEFAULT_TIMEOUT_MS,
	buildAndCacheKbCatalogContext,
	fetchWithTimeout,
	findNearestProjectConfigPath,
	getCachedKbCatalogContextForCwd,
	getGlobalConfigPath,
	getOrBuildKbCatalogContext,
	invalidateKbCatalogCache,
	parseKbIndexArgs,
	loadConfig,
	maskApiKey,
	requireBraveApiKey,
	requireDistillerSettings,
	resolveScopes,
	runDistillerModel,
	runKbSearch,
	runKbUnionSearch,
	stripInjectedKbCatalogPrompt,
	truncate,
	validateKbIndexSourceIds,
	type DistillerSourceInput,
	type KnowmoreConfig,
} from "./core.js";

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



const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

const searchCache = new Map<string, SearchCacheEntry>();
const urlCache = new Map<string, UrlCacheEntry>();


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

function formatKbUnionClauses(allClauses: unknown, anyClauses: unknown, maxChars: number): string {
	const all = (Array.isArray(allClauses) ? allClauses : [])
		.filter((clause): clause is string => typeof clause === "string")
		.map((clause) => clause.trim())
		.filter((clause) => clause.length > 0);
	const any = (Array.isArray(anyClauses) ? anyClauses : [])
		.filter((clause): clause is string => typeof clause === "string")
		.map((clause) => clause.trim())
		.filter((clause) => clause.length > 0);
	if (all.length === 0 && any.length === 0) return "(empty query)";
	const allPart = all.length > 0 ? `all:[${all.map((clause) => `"${clause}"`).join(", ")}]` : "";
	const anyPart = any.length > 0 ? `any:[${any.map((clause) => `"${clause}"`).join(", ")}]` : "";
	const combined = [allPart, anyPart].filter(Boolean).join(" ");
	return truncate(combined, maxChars);
}

function getKbUnionSearchSummary(details: any): string {
	const query = formatKbUnionClauses(details?.all, details?.any, 80);
	const resultCount = Array.isArray(details?.results) ? details.results.length : 0;
	const distilled = details?.distilled ? " (distilled)" : "";
	return `${resultCount} KB union match${resultCount === 1 ? "" : "es"} for ${query}${distilled}`;
}





function getSearchCacheKey(query: string, count: number): string {
	return `${query}\u0000${count}`;
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
			"Choose scope correctly: project for project-* sources, shared for shared-* sources, all for both.",
			"Unless you know the exact term precisely, use kb_union_search with a broader query instead might be a good idea.",
			"If it doesn't find what you need, try a broader (shorter) query or some synonyms or try kb_union_search instead.",
			"If you find a chunk that's relevant but insufficient, follow up with a direct read of the source file for more context.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Lexical search query" }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("shared"), Type.Literal("all")], {
					description: "Which index to search",
					default: "all",
				}),
			),
			sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional source IDs to scope search" })),
			topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 8 })),
			pathPrefix: Type.Optional(Type.String({ description: "Optional absolute path prefix filter" })),
		}),
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? truncate(args.query, 100) : "";
			const topK = typeof args?.topK === "number" ? ` topK=${args.topK}` : "";
			const scope = typeof args?.scope === "string" ? ` scope=${args.scope}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("kb_search"))} ${theme.fg("accent", query)}${theme.fg("muted", `${topK}${scope}`)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return renderCollapsedSummary(theme, getKbSearchSummary(result.details));
			return renderExpandedText(result, theme);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const output = runKbSearch(ctx.cwd, params);
			return { content: [{ type: "text", text: output.text }], details: output.details };
		},
	});

	pi.registerTool({
		name: "kb_union_search",
		label: "KB Union Search",
		description:
			"Searches local indexed KB chunks using structured ALL + ANY query. Optionally distills expanded local file contexts in one call.",
		promptSnippet: "Run local KB OR-union retrieval with optional one-shot distillation.",
		promptGuidelines: [
			"Choose scope correctly: project for project-* sources, shared for shared-* sources, all for both.",
			"If you don't know the precise terms, you might put synonyms or related terms in any[] for broader coverage.",
            "Most of time, leave all[] empty and use any[] for broader coverage, unless you need to ensure exact match.",
			"Set distill=true when you want distilled context from local chunk neighborhoods. If distill=false, returns raw chunks.",
			"Use intent when you want to guide the distiller on what to prioritize (e.g., constraints, comparison criteria, output focus).",
            "Stop once you got enough information, no need to over research.",
		],
		parameters: Type.Object({
			all: Type.Array(Type.String({ minLength: 1 }), { description: "Only return results that match all these clauses." }),
			any: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Return results that match at least one of these clauses." })),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("shared"), Type.Literal("all")], {
					description: "Which index to search",
					default: "all",
				}),
			),
			sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Optional source IDs to scope search" })),
			topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
			pathPrefix: Type.Optional(Type.String({ description: "Optional absolute path prefix filter" })),
			distill: Type.Optional(Type.Boolean({ default: true, description: "If true, expand local context and distill before returning." })),
			intent: Type.Optional(Type.String({ description: "Optional distillation intent to guide what evidence should be prioritized." })),
			maxChunksToDistill: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 20 })),
			maxCharsPerChunk: Type.Optional(Type.Integer({ minimum: 400, maximum: 12000, default: 5000 })),
		}),
		renderCall(args, theme) {
			const query = formatKbUnionClauses(args?.all, args?.any, 100);
			const topK = typeof args?.topK === "number" ? ` topK=${args.topK}` : "";
			const scope = typeof args?.scope === "string" ? ` scope=${args.scope}` : "";
			const distill = args?.distill ? " distill" : "";
			const intent = typeof args?.intent === "string" && args.intent.trim().length > 0 ? " intent" : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("kb_union_search"))} ${theme.fg("accent", query)}${theme.fg("muted", `${topK}${scope}${distill}${intent}`)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return renderCollapsedSummary(theme, getKbUnionSearchSummary(result.details));
			return renderExpandedText(result, theme);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const output = await runKbUnionSearch(ctx.cwd, params, signal);
			return { content: [{ type: "text", text: output.text }], details: output.details };
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
		description: "Fetches and extracts readable text from a URL. Use this after km_search_web for deeper context, or when the user/a ticket specifies URL(s) for reference.",
		promptSnippet: "Fetches and extracts readable text from a URL.",
		promptGuidelines: [
			"If used after km_search_web, use km_fetch_url only for top relevant URLs; avoid fetching many pages at once.",
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
		name: "km_fetch_url_full",
		label: "KM Fetch URL (Full)",
		description: "Fetches and extracts all readable text from a URL without applying knowmore's character truncation. Use with care for very large pages.",
		promptSnippet: "Fetches all extracted readable text from a URL without truncation.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute URL to fetch" }),
		}),
		renderCall(args, theme) {
			const url = typeof args?.url === "string" ? truncate(args.url, 120) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("km_fetch_url_full"))} ${theme.fg("accent", url)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return renderCollapsedSummary(theme, getFetchUrlSummary(result.details));
			return renderExpandedText(result, theme);
		},
		async execute(_toolCallId, params, signal) {
			const url = params.url.trim();
			if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");

			// Do not use the bounded km_fetch_url cache: it may contain truncated content.
			const fetched = await fetchUrlContent(url, Number.MAX_SAFE_INTEGER, signal);
			return {
				content: [{ type: "text", text: `Fetched full URL content for ${url}${fetched.title ? `\\nTitle: ${fetched.title}` : ""}\\n\\n${fetched.content}` }],
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
		description: "Manage local KB index. Usage: /kb-index update [--scope project|shared|all] [--source <id>] [--reindex] | /kb-index status | /kb-index clear [--scope project|shared|all] [--source <id>]",
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

			const indexPaths = resolveKbIndexPaths(ctx.cwd, loaded.projectConfigPath);
			const sourceIds = parsed.sourceIds.length > 0 ? parsed.sourceIds : undefined;

			const kbIndexStatusKey = "knowmore.kb-index";

			try {
				const targetScopes = resolveScopes(parsed.scope).filter((scope) => {
					const indexPath = pickKbIndexPath(indexPaths, scope);
					return scope !== "project" || indexPath.available;
				});
				if (targetScopes.length === 0) {
					throw new Error("Project index scope requested but no project knowmore.config.json was found.");
				}

				if (parsed.action === "status") {
					const statuses = targetScopes.map((scope) => {
						const indexPath = pickKbIndexPath(indexPaths, scope);
						return { scope, status: getKbIndexStatus(indexPath.dbPath) };
					});
					pi.sendMessage({
						customType: "kb-index-status",
						content: statuses.map(({ scope, status }) => `# ${scope}\n${formatKbIndexStatus(status)}`).join("\n\n"),
						display: true,
						details: statuses,
					});
					ctx.ui.notify(`kb-index OK | status | ${targetScopes.join(", ")}`, "info");
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
					const cleared = targetScopes.map((scope) => {
						const indexPath = pickKbIndexPath(indexPaths, scope);
						return { scope, result: clearKbIndex(indexPath.dbPath, scope, sourceIds) };
					});
					pi.sendMessage({
						customType: "kb-index-clear",
						content: cleared
							.map(({ scope, result }) => {
								const clearedSummary =
									result.clearedSources.length === 0
										? "none"
										: result.clearedSources[0] === "*"
											? "all"
											: `${result.clearedSources.length} source(s)`;
								return `KB index cleared (${scope}: ${clearedSummary})\nDB: \`${result.dbPath}\``;
							})
							.join("\n\n"),
						display: true,
						details: cleared,
					});
					ctx.ui.notify(`kb-index OK | clear | ${targetScopes.join(", ")}`, "info");
					return;
				}

				const kbCatalog = buildKnowledgeBaseCatalog(loaded.config, {
					globalConfigPath: loaded.globalConfigPath,
					projectConfigPath: loaded.projectConfigPath,
				});
				ensureKnowledgeBaseReferencesExist(kbCatalog);
				validateKbIndexSourceIds(kbCatalog, parsed.scope, sourceIds);

				ctx.ui.setStatus(kbIndexStatusKey, "kb-index: preparing sources...");
				const updates: Array<{ scope: Exclude<KbIndexScope, "all">; updated: Awaited<ReturnType<typeof updateKbIndex>> }> = [];
				for (const scope of targetScopes) {
					const indexPath = pickKbIndexPath(indexPaths, scope);
					const updated = await updateKbIndex(indexPath.dbPath, kbCatalog, {
						scope,
						sourceIds,
						reindex: parsed.reindex,
						onSourceStart: (event) => {
							pi.sendMessage({
								customType: "kb-index-progress",
								content: `Indexing source ${event.sourceIndex}/${event.totalSources}: \`${event.sourceId}\`\nPath: \`${event.sourcePath}\``,
								display: true,
								details: { scope, ...event },
							});
						},
						onFileProgress: (event) => {
							const action = event.phase === "remove" ? "removing" : "indexing";
							ctx.ui.setStatus(
								kbIndexStatusKey,
								`kb-index(${scope}): ${event.sourceId} | ${action} ${event.fileIndex}/${event.totalFiles} | ${path.basename(event.filePath)}`,
							);
						},
					});
					updates.push({ scope, updated });
				}
				pi.sendMessage({
					customType: "kb-index-update",
					content: updates.map(({ scope, updated }) => `# ${scope}\n${formatKbIndexUpdateResult(updated)}`).join("\n\n"),
					display: true,
					details: updates,
				});
				const updatedSources = updates.reduce((acc, entry) => acc + entry.updated.sources.length, 0);
				ctx.ui.notify(`kb-index OK | updated ${updatedSources} source(s)`, "info");
			} catch (error) {
				ctx.ui.notify(`kb-index FAILED | ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus(kbIndexStatusKey, undefined);
			}
		},
	});

	pi.registerMessageRenderer("tools-list", (message, { expanded }, theme) => {
		const details = message.details as
			| {
					total: number;
					active: Array<{ name: string; source: string; description: string }>;
					inactive: Array<{ name: string; source: string; description: string }>;
			  }
			| undefined;
		if (!details) return new Text(typeof message.content === "string" ? message.content : "", 0, 0);

		const formatTool = (tool: { name: string; source: string; description: string }): string => {
			const name = theme.fg("accent", theme.bold(tool.name));
			const source = theme.fg("muted", `[${tool.source}]`);
			const desc = theme.fg("toolOutput", tool.description);
			return expanded ? `- ${name} ${source}\n    ${desc}` : `- ${name} ${source} — ${desc}`;
		};

		const lines: string[] = [
			theme.fg("toolTitle", theme.bold(`Tools (${details.active.length} active / ${details.total} total)`)),
			"",
			theme.fg("success", `Active (${details.active.length}):`),
			...(details.active.length > 0 ? details.active.map(formatTool) : [theme.fg("muted", "- (none)")]),
			"",
			theme.fg("text", `Inactive (${details.inactive.length}):`),
			...(details.inactive.length > 0 ? details.inactive.map(formatTool) : [theme.fg("muted", "- (none)")]),
		];

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	pi.registerCommand("tools", {
		description: "List active and available tools in this session",
		handler: async (_args, ctx) => {
			const allTools = pi.getAllTools().slice().sort((a, b) => a.name.localeCompare(b.name));
			const activeSet = new Set(pi.getActiveTools());
			const serializeTool = (tool: (typeof allTools)[number]) => ({
				name: tool.name,
				source: tool.sourceInfo?.source ?? "unknown",
				description:
					typeof tool.description === "string" && tool.description.trim().length > 0
						? truncate(tool.description.trim(), 220)
						: "(no description)",
			});

			const activeTools = allTools.filter((tool) => activeSet.has(tool.name)).map(serializeTool);
			const inactiveTools = allTools.filter((tool) => !activeSet.has(tool.name)).map(serializeTool);

			pi.sendMessage({
				customType: "tools-list",
				content: `Tools (${activeTools.length} active / ${allTools.length} total)`,
				display: true,
				details: {
					total: allTools.length,
					active: activeTools,
					inactive: inactiveTools,
				},
			});
			ctx.ui.notify(`tools | ${activeTools.length} active / ${allTools.length} total`, "info");
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
			const kbIndexPaths = resolveKbIndexPaths(ctx.cwd, projectConfigPath);
			const sharedIndexPath = pickKbIndexPath(kbIndexPaths, "shared");
			const projectIndexPath = pickKbIndexPath(kbIndexPaths, "project");
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
					kbProjectIndex: {
						available: projectIndexPath.available,
						indexDir: projectIndexPath.indexDir,
						dbPath: projectIndexPath.dbPath,
					},
					kbSharedIndex: {
						available: sharedIndexPath.available,
						indexDir: sharedIndexPath.indexDir,
						dbPath: sharedIndexPath.dbPath,
					},
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
			invalidateKbCatalogCache();
			ctx.ui.notify("Knowmore caches cleared", "info");
		},
	});
}