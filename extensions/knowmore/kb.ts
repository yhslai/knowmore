import * as fs from "node:fs";
import * as path from "node:path";

export interface KnowmoreKnowledgeBaseConfig {
	PROJECT_KNOWLEDGE_BASE?: string;
	SHARED_KNOWLEDGE_BASE?: string;
}

export type KnowledgeBaseRootId = "project" | "shared";

export interface KnowledgeBaseSource {
	id: string;
	name: string;
	path: string;
	scope: KnowledgeBaseRootId;
	rootId: KnowledgeBaseRootId;
	origin: "implicit" | "explicit";
	description?: string;
	exists: boolean;
	insideRoot: boolean;
}

export interface KnowledgeBaseRoot {
	id: KnowledgeBaseRootId;
	label: string;
	configField: "PROJECT_KNOWLEDGE_BASE" | "SHARED_KNOWLEDGE_BASE";
	configuredValue: string;
	path: string;
	exists: boolean;
	catalogPath: string;
	catalogExists: boolean;
	warnings: string[];
}

export interface KnowledgeBaseCatalogResult {
	roots: KnowledgeBaseRoot[];
	sources: KnowledgeBaseSource[];
	warnings: string[];
}

interface ExplicitCatalogEntry {
	id?: unknown;
	path?: unknown;
	description?: unknown;
	name?: unknown;
}

interface BuildKnowledgeBaseCatalogInput {
	globalConfigPath: string | null;
	projectConfigPath: string | null;
}

function toSafeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeId(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120);
}

function ensureUniqueId(baseId: string, usedIds: Set<string>): string {
	const normalized = normalizeId(baseId) || "source";
	if (!usedIds.has(normalized)) {
		usedIds.add(normalized);
		return normalized;
	}

	let i = 2;
	while (usedIds.has(`${normalized}-${i}`)) i += 1;
	const unique = `${normalized}-${i}`;
	usedIds.add(unique);
	return unique;
}

function makeRootLabel(rootId: KnowledgeBaseRootId): string {
	return rootId === "project" ? "Project KB" : "Shared KB";
}

function tryReadDirEntries(dirPath: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}
}

function loadExplicitCatalog(catalogPath: string): { entries: ExplicitCatalogEntry[]; warnings: string[] } {
	if (!fs.existsSync(catalogPath)) return { entries: [], warnings: [] };

	let raw = "";
	try {
		raw = fs.readFileSync(catalogPath, "utf-8");
	} catch (error) {
		return {
			entries: [],
			warnings: [`Failed reading ${catalogPath}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			entries: [],
			warnings: [`Invalid JSON in ${catalogPath}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	if (Array.isArray(parsed)) {
		return { entries: parsed as ExplicitCatalogEntry[], warnings: [] };
	}

	if (parsed && typeof parsed === "object" && Array.isArray((parsed as { sources?: unknown }).sources)) {
		return {
			entries: (parsed as { sources: ExplicitCatalogEntry[] }).sources,
			warnings: [
				`${catalogPath}: object format with {"sources": [...]} is deprecated; please use a top-level array instead.`,
			],
		};
	}

	return { entries: [], warnings: [`${catalogPath} must be a JSON array of source entries.`] };
}

function createRootDescriptor(
	rootId: KnowledgeBaseRootId,
	configuredValue: string,
	resolvedPath: string,
): KnowledgeBaseRoot {
	const exists = fs.existsSync(resolvedPath);
	const catalogPath = path.join(resolvedPath, "kb.catalog.json");
	const warnings: string[] = [];

	if (!exists) {
		warnings.push(`KB root does not exist: ${resolvedPath}`);
	}

	return {
		id: rootId,
		label: makeRootLabel(rootId),
		configField: rootId === "project" ? "PROJECT_KNOWLEDGE_BASE" : "SHARED_KNOWLEDGE_BASE",
		configuredValue,
		path: resolvedPath,
		exists,
		catalogPath,
		catalogExists: exists && fs.existsSync(catalogPath),
		warnings,
	};
}

function resolveRoots(
	config: KnowmoreKnowledgeBaseConfig,
	input: BuildKnowledgeBaseCatalogInput,
): { roots: KnowledgeBaseRoot[]; warnings: string[] } {
	const roots: KnowledgeBaseRoot[] = [];
	const warnings: string[] = [];

	const projectKbRaw = toSafeString(config.PROJECT_KNOWLEDGE_BASE);
	if (projectKbRaw) {
		if (path.isAbsolute(projectKbRaw)) {
			warnings.push("PROJECT_KNOWLEDGE_BASE must be relative to the project config folder.");
		} else if (!input.projectConfigPath) {
			warnings.push("PROJECT_KNOWLEDGE_BASE is set but no project knowmore.config.json was found to resolve it.");
		} else {
			const projectConfigDir = path.dirname(input.projectConfigPath);
			const projectKbPath = path.resolve(projectConfigDir, projectKbRaw);
			roots.push(createRootDescriptor("project", projectKbRaw, projectKbPath));
		}
	}

	const sharedKbRaw = toSafeString(config.SHARED_KNOWLEDGE_BASE);
	if (sharedKbRaw) {
		if (!path.isAbsolute(sharedKbRaw)) {
			warnings.push("SHARED_KNOWLEDGE_BASE must be an absolute path.");
		} else {
			roots.push(createRootDescriptor("shared", sharedKbRaw, path.resolve(sharedKbRaw)));
		}
	}

	if (roots.length === 0) {
		warnings.push("No KB roots are configured (PROJECT_KNOWLEDGE_BASE and SHARED_KNOWLEDGE_BASE are both missing/invalid).");
	}

	return { roots, warnings };
}

function discoverImplicitSources(root: KnowledgeBaseRoot, usedIds: Set<string>): KnowledgeBaseSource[] {
	if (!root.exists) return [];

	const entries = tryReadDirEntries(root.path)
		.filter((entry) => entry.name !== "kb.catalog.json" && entry.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name));

	const sources: KnowledgeBaseSource[] = [];
	for (const entry of entries) {
		const sourcePath = path.resolve(root.path, entry.name);
		const id = ensureUniqueId(`${root.id}:${entry.name}`, usedIds);
		sources.push({
			id,
			name: entry.name,
			path: sourcePath,
			scope: root.id,
			rootId: root.id,
			origin: "implicit",
			exists: fs.existsSync(sourcePath),
			insideRoot: true,
		});
	}
	return sources;
}

function discoverExplicitSources(root: KnowledgeBaseRoot, usedIds: Set<string>): { sources: KnowledgeBaseSource[]; warnings: string[] } {
	if (!root.exists) return { sources: [], warnings: [] };

	const { entries, warnings } = loadExplicitCatalog(root.catalogPath);
	if (!entries || entries.length === 0) return { sources: [], warnings };

	const sources: KnowledgeBaseSource[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const rawPath = toSafeString(entry.path);
		if (!rawPath) {
			warnings.push(`Invalid source at ${root.catalogPath} index ${i}: missing non-empty 'path'.`);
			continue;
		}

		const resolvedPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root.path, rawPath);
		const name = toSafeString(entry.name) ?? (path.basename(resolvedPath) || `source-${i + 1}`);
		const preferredId = toSafeString(entry.id) ?? `${root.id}:${name}`;
		const id = ensureUniqueId(preferredId, usedIds);
		const exists = fs.existsSync(resolvedPath);

		if (exists) {
			const stats = fs.statSync(resolvedPath);
			if (!stats.isDirectory()) {
				warnings.push(`Invalid source at ${root.catalogPath} index ${i}: path must be a directory (${resolvedPath}).`);
				continue;
			}
		}

		sources.push({
			id,
			name,
			path: resolvedPath,
			scope: root.id,
			rootId: root.id,
			origin: "explicit",
			description: toSafeString(entry.description) ?? undefined,
			exists,
			insideRoot: isPathInside(root.path, resolvedPath),
		});
	}

	return { sources, warnings };
}

export function buildKnowledgeBaseCatalog(
	config: KnowmoreKnowledgeBaseConfig,
	input: BuildKnowledgeBaseCatalogInput,
): KnowledgeBaseCatalogResult {
	const rootResolution = resolveRoots(config, input);
	const usedIds = new Set<string>();
	const sources: KnowledgeBaseSource[] = [];
	const warnings = [...rootResolution.warnings];

	for (const root of rootResolution.roots) {
		sources.push(...discoverImplicitSources(root, usedIds));
		const explicit = discoverExplicitSources(root, usedIds);
		sources.push(...explicit.sources);
		warnings.push(...root.warnings, ...explicit.warnings);
	}

	return {
		roots: rootResolution.roots,
		sources,
		warnings,
	};
}

export function discoverKnowledgeBases(
	config: KnowmoreKnowledgeBaseConfig,
	input: BuildKnowledgeBaseCatalogInput,
): KnowledgeBaseCatalogResult {
	return buildKnowledgeBaseCatalog(config, input);
}

export function formatKnowledgeBaseCatalog(catalog: KnowledgeBaseCatalogResult): string {
	const lines: string[] = [];
	lines.push("Local KB catalog");
	lines.push("");

	if (catalog.roots.length === 0) {
		lines.push("No KB roots configured.");
	} else {
		lines.push(`Roots (${catalog.roots.length}):`);
		for (const root of catalog.roots) {
			lines.push(`- ${root.id} (${root.label})`);
			lines.push(`  config: ${root.configField} = ${root.configuredValue}`);
			lines.push(`  path: ${root.path}`);
			lines.push(`  exists: ${root.exists ? "yes" : "no"}`);
			lines.push(`  explicitCatalog: ${root.catalogExists ? root.catalogPath : "(none)"}`);
		}
	}

	lines.push("");
	lines.push(`Sources (${catalog.sources.length}):`);
	if (catalog.sources.length === 0) {
		lines.push("- (none)");
	} else {
		for (const source of catalog.sources) {
			const descText = source.description ? `\n  description: ${source.description}` : "";
			lines.push(`- ${source.id} | ${source.origin} | ${source.scope} | ${source.exists ? "exists" : "missing"} | ${source.path}${descText}`);
		}
	}

	if (catalog.warnings.length > 0) {
		lines.push("");
		lines.push(`Warnings (${catalog.warnings.length}):`);
		for (const warning of catalog.warnings) lines.push(`- ${warning}`);
	}

	return lines.join("\n");
}
