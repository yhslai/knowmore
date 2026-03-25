import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KnowledgeBaseCatalogResult, KnowledgeBaseRootId, KnowledgeBaseSource } from "./kb.js";
import { preprocessDocumentTextForKb } from "./content-cleaning.js";

export type KbIndexScope = "project" | "shared" | "all";

export interface KbIndexPaths {
	baseDir: string;
	indexDir: string;
	dbPath: string;
}

export interface KbIndexUpdateOptions {
	scope: KbIndexScope;
	sourceIds?: string[];
	reindex?: boolean;
	onSourceStart?: (event: {
		sourceId: string;
		rootId: KnowledgeBaseRootId;
		sourcePath: string;
		sourceIndex: number;
		totalSources: number;
	}) => void | Promise<void>;
	onFileProgress?: (event: {
		sourceId: string;
		filePath: string;
		fileIndex: number;
		totalFiles: number;
		phase: "index" | "remove";
	}) => void | Promise<void>;
}

export interface KbIndexUpdateResult {
	dbPath: string;
	scope: KbIndexScope;
	sources: Array<{
		sourceId: string;
		rootId: KnowledgeBaseRootId;
		indexed: boolean;
		filesDiscovered: number;
		filesReindexed: number;
		filesUnchanged: number;
		filesRemoved: number;
		chunksWritten: number;
		skippedFiles: number;
		errors: string[];
	}>;
	processedAt: string;
}

export interface KbSearchOptions {
	query: string;
	topK: number;
	sourceIds?: string[];
	pathPrefix?: string;
}

export interface KbUnionSearchOptions {
	all: string[];
	any?: string[];
	topK: number;
	sourceIds?: string[];
	pathPrefix?: string;
}

export interface KbSearchResultItem {
	sourceId: string;
	filePath: string;
	startLine: number;
	endLine: number;
	text: string;
	score: number;
}

export interface KbSearchResult {
	dbPath: string;
	query: string;
	topK: number;
	results: KbSearchResultItem[];
}

export interface KbUnionSearchResult extends KbSearchResult {
	all: string[];
	any: string[];
	matchQuery: string;
}

interface IndexedFileRow {
	source_id: string;
	file_path: string;
	mtime_ms: number;
	size_bytes: number;
}

interface Chunk {
	startLine: number;
	endLine: number;
	text: string;
}

const EXCLUDED_DIR_NAMES = new Set([
	".git",
	"node_modules",
	".idea",
	".vscode",
	"dist",
	"build",
	"out",
	"target",
	"bin",
	"obj",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	"coverage",
]);

const ALLOWED_EXTENSIONS = new Set([
	".md",
	".mdx",
	".txt",
	".rst",
	".adoc",
	".json",
	".jsonc",
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".conf",
	".xml",
	".html",
	".htm",
	".csv",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".java",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".cs",
	".go",
	".rs",
	".php",
	".rb",
	".swift",
	".kt",
	".kts",
	".scala",
	".sql",
	".sh",
	".ps1",
	".bat",
	".cmd",
	".tex",
]);

const MAX_FILE_BYTES = 2_000_000;
const MAX_CHUNK_LINES = 60;
const CHUNK_OVERLAP_LINES = 10;
const YIELD_EVERY_STEPS = 25;

async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export function resolveKbIndexPaths(cwd: string, projectConfigPath: string | null, configuredIndexDir?: string): KbIndexPaths {
	const baseDir = projectConfigPath ? path.dirname(projectConfigPath) : path.resolve(cwd);
	const configured = configuredIndexDir?.trim();
	const indexDir =
		configured && configured.length > 0
			? path.isAbsolute(configured)
				? path.resolve(configured)
				: path.resolve(baseDir, configured)
			: path.join(baseDir, ".knowmore", "kb-index");
	const dbPath = path.join(indexDir, "kb.sqlite");
	return { baseDir, indexDir, dbPath };
}

function ensureParentDir(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function openDb(dbPath: string): DatabaseSync {
	ensureParentDir(dbPath);
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	db.exec("PRAGMA temp_store = MEMORY;");
	db.exec(`
CREATE TABLE IF NOT EXISTS indexed_files (
	source_id TEXT NOT NULL,
	file_path TEXT NOT NULL,
	mtime_ms INTEGER NOT NULL,
	size_bytes INTEGER NOT NULL,
	indexed_at INTEGER NOT NULL,
	PRIMARY KEY (source_id, file_path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks USING fts5(
	text,
	source_id UNINDEXED,
	file_path UNINDEXED,
	start_line UNINDEXED,
	end_line UNINDEXED,
	tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS kb_index_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`);
	return db;
}

function pickSources(catalog: KnowledgeBaseCatalogResult, scope: KbIndexScope, sourceIds?: string[]): KnowledgeBaseSource[] {
	const ids = new Set((sourceIds ?? []).map((v) => v.trim()).filter((v) => v.length > 0));
	const scopedSources = catalog.sources.filter((source) => {
		if (scope !== "all" && source.rootId !== scope) return false;
		return true;
	});
	if (ids.size > 0) {
		const scopedIds = new Set(scopedSources.map((source) => source.id));
		const unknown = [...ids].filter((id) => !scopedIds.has(id)).sort((a, b) => a.localeCompare(b));
		if (unknown.length > 0) {
			const available = scopedSources.map((source) => source.id).sort((a, b) => a.localeCompare(b));
			const availablePreview = available.slice(0, 20);
			const availableSuffix = available.length > availablePreview.length ? " ..." : "";
			throw new Error(
				`Unknown source ID(s) for scope '${scope}': ${unknown.join(", ")}${available.length > 0 ? `\nAvailable: ${availablePreview.join(", ")}${availableSuffix}` : "\nNo sources available for this scope."}`,
			);
		}
	}
	const filtered = scopedSources.filter((source) => {
		if (ids.size > 0 && !ids.has(source.id)) return false;
		return true;
	});
	return filtered.sort((a, b) => a.id.localeCompare(b.id));
}

function shouldIndexFile(filePath: string): boolean {
	const base = path.basename(filePath).toLowerCase();
	if (base === "dockerfile") return true;
	const ext = path.extname(filePath).toLowerCase();
	if (!ext) return true;
	return ALLOWED_EXTENSIONS.has(ext);
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
	const files: string[] = [];
	const stack = [rootDir];
	let steps = 0;

	while (stack.length > 0) {
		if (steps > 0 && steps % YIELD_EVERY_STEPS === 0) {
			await yieldToEventLoop();
		}
		steps += 1;
		const current = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
				stack.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!shouldIndexFile(fullPath)) continue;
			files.push(path.resolve(fullPath));
		}
	}

	files.sort((a, b) => a.localeCompare(b));
	return files;
}

function isLikelyBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
	for (let i = 0; i < sample.length; i++) {
		if (sample[i] === 0) return true;
	}
	return false;
}

function chunkText(text: string): Chunk[] {
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines.length === 0) return [];

	const chunks: Chunk[] = [];
	let start = 0;
	while (start < lines.length) {
		const endExclusive = Math.min(lines.length, start + MAX_CHUNK_LINES);
		const slice = lines.slice(start, endExclusive).join("\n").trim();
		if (slice.length > 0) {
			chunks.push({ startLine: start + 1, endLine: endExclusive, text: slice });
		}
		if (endExclusive >= lines.length) break;
		start = Math.max(start + 1, endExclusive - CHUNK_OVERLAP_LINES);
	}
	return chunks;
}

function deleteIndexedFile(db: DatabaseSync, sourceId: string, filePath: string): void {
	db.prepare("DELETE FROM kb_chunks WHERE source_id = ? AND file_path = ?;").run(sourceId, filePath);
	db.prepare("DELETE FROM indexed_files WHERE source_id = ? AND file_path = ?;").run(sourceId, filePath);
}

function upsertIndexedFile(db: DatabaseSync, sourceId: string, filePath: string, mtimeMs: number, sizeBytes: number): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO indexed_files(source_id, file_path, mtime_ms, size_bytes, indexed_at)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(source_id, file_path) DO UPDATE SET
	mtime_ms = excluded.mtime_ms,
	size_bytes = excluded.size_bytes,
	indexed_at = excluded.indexed_at;`,
	).run(sourceId, filePath, Math.trunc(mtimeMs), sizeBytes, now);
}

function indexFile(db: DatabaseSync, sourceId: string, filePath: string): { skipped: boolean; chunksWritten: number; mtimeMs: number; sizeBytes: number } {
	const stat = fs.statSync(filePath);
	if (!stat.isFile()) return { skipped: true, chunksWritten: 0, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
	if (stat.size > MAX_FILE_BYTES) return { skipped: true, chunksWritten: 0, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };

	const raw = fs.readFileSync(filePath);
	if (isLikelyBinary(raw)) return { skipped: true, chunksWritten: 0, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };

	const rawText = raw.toString("utf-8");
	const text = preprocessDocumentTextForKb(rawText, filePath);
	const chunks = chunkText(text);

	deleteIndexedFile(db, sourceId, filePath);
	if (chunks.length > 0) {
		const insertChunk = db.prepare(
			"INSERT INTO kb_chunks(text, source_id, file_path, start_line, end_line) VALUES(?, ?, ?, ?, ?);",
		);
		for (const chunk of chunks) {
			insertChunk.run(chunk.text, sourceId, filePath, chunk.startLine, chunk.endLine);
		}
	}
	upsertIndexedFile(db, sourceId, filePath, stat.mtimeMs, stat.size);

	return { skipped: false, chunksWritten: chunks.length, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
}

function getExistingFilesBySource(db: DatabaseSync, sourceId: string): Map<string, IndexedFileRow> {
	const rows = db
		.prepare("SELECT source_id, file_path, mtime_ms, size_bytes FROM indexed_files WHERE source_id = ?;")
		.all(sourceId) as unknown as IndexedFileRow[];
	const map = new Map<string, IndexedFileRow>();
	for (const row of rows) map.set(row.file_path, row);
	return map;
}

function setMetaValue(db: DatabaseSync, key: string, value: string): void {
	db.prepare(
		`INSERT INTO kb_index_meta(key, value) VALUES(?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
	).run(key, value);
}

function begin(db: DatabaseSync): void {
	db.exec("BEGIN IMMEDIATE;");
}

function commit(db: DatabaseSync): void {
	db.exec("COMMIT;");
}

function rollback(db: DatabaseSync): void {
	db.exec("ROLLBACK;");
}

export async function updateKbIndex(
	dbPath: string,
	catalog: KnowledgeBaseCatalogResult,
	options: KbIndexUpdateOptions,
): Promise<KbIndexUpdateResult> {
	const db = openDb(dbPath);
	const selectedSources = pickSources(catalog, options.scope, options.sourceIds);
	const sourceResults: KbIndexUpdateResult["sources"] = [];

	try {
		for (let sourceIndex = 0; sourceIndex < selectedSources.length; sourceIndex++) {
			const source = selectedSources[sourceIndex]!;
			await options.onSourceStart?.({
				sourceId: source.id,
				rootId: source.rootId,
				sourcePath: source.path,
				sourceIndex: sourceIndex + 1,
				totalSources: selectedSources.length,
			});
			await yieldToEventLoop();

			const errors: string[] = [];
			if (!source.exists) {
				sourceResults.push({
					sourceId: source.id,
					rootId: source.rootId,
					indexed: false,
					filesDiscovered: 0,
					filesReindexed: 0,
					filesUnchanged: 0,
					filesRemoved: 0,
					chunksWritten: 0,
					skippedFiles: 0,
					errors: [`Source path does not exist: ${source.path}`],
				});
				continue;
			}

			const discoveredFiles = await listFilesRecursive(source.path);
			const existing = getExistingFilesBySource(db, source.id);
			const discoveredSet = new Set(discoveredFiles);

			let filesReindexed = 0;
			let filesUnchanged = 0;
			let filesRemoved = 0;
			let chunksWritten = 0;
			let skippedFiles = 0;

			for (let fileIndex = 0; fileIndex < discoveredFiles.length; fileIndex++) {
				const filePath = discoveredFiles[fileIndex]!;
				await options.onFileProgress?.({
					sourceId: source.id,
					filePath,
					fileIndex: fileIndex + 1,
					totalFiles: discoveredFiles.length,
					phase: "index",
				});
				if (fileIndex > 0 && fileIndex % YIELD_EVERY_STEPS === 0) {
					await yieldToEventLoop();
				}
				let stat: fs.Stats;
				try {
					stat = fs.statSync(filePath);
				} catch (error) {
					errors.push(`Failed stat ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}

				const prior = existing.get(filePath);
				const unchanged =
					!options.reindex &&
					prior &&
					Math.trunc(prior.mtime_ms) === Math.trunc(stat.mtimeMs) &&
					prior.size_bytes === stat.size;

				if (unchanged) {
					filesUnchanged += 1;
					continue;
				}

				try {
					begin(db);
					const indexed = indexFile(db, source.id, filePath);
					commit(db);
					filesReindexed += 1;
					chunksWritten += indexed.chunksWritten;
					if (indexed.skipped) skippedFiles += 1;
				} catch (error) {
					try {
						rollback(db);
					} catch {
						// ignore rollback error
					}
					errors.push(`Failed indexing ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			const stalePaths = [...existing.keys()].filter((stalePath) => !discoveredSet.has(stalePath));
			for (let staleIndex = 0; staleIndex < stalePaths.length; staleIndex++) {
				const stalePath = stalePaths[staleIndex]!;
				await options.onFileProgress?.({
					sourceId: source.id,
					filePath: stalePath,
					fileIndex: staleIndex + 1,
					totalFiles: stalePaths.length,
					phase: "remove",
				});
				if (staleIndex > 0 && staleIndex % YIELD_EVERY_STEPS === 0) {
					await yieldToEventLoop();
				}
				try {
					begin(db);
					deleteIndexedFile(db, source.id, stalePath);
					commit(db);
					filesRemoved += 1;
				} catch (error) {
					try {
						rollback(db);
					} catch {
						// ignore rollback error
					}
					errors.push(`Failed removing stale file ${stalePath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			sourceResults.push({
				sourceId: source.id,
				rootId: source.rootId,
				indexed: true,
				filesDiscovered: discoveredFiles.length,
				filesReindexed,
				filesUnchanged,
				filesRemoved,
				chunksWritten,
				skippedFiles,
				errors,
			});
		}

		setMetaValue(db, "schemaVersion", "2");
		setMetaValue(db, "lastUpdatedAt", new Date().toISOString());
		setMetaValue(db, "lastScope", options.scope);
		db.prepare("DELETE FROM kb_index_meta WHERE key = ?;").run("lastSourceIds");
	} finally {
		db.close();
	}

	return {
		dbPath,
		scope: options.scope,
		sources: sourceResults,
		processedAt: new Date().toISOString(),
	};
}

export function getKbIndexStatus(dbPath: string): {
	dbPath: string;
	exists: boolean;
	sourceStats: Array<{ sourceId: string; fileCount: number; chunkCount: number }>;
	meta: Record<string, string>;
} {
	if (!fs.existsSync(dbPath)) {
		return { dbPath, exists: false, sourceStats: [], meta: {} };
	}

	const db = openDb(dbPath);
	try {
		const fileRows = db
			.prepare("SELECT source_id as sourceId, COUNT(*) as fileCount FROM indexed_files GROUP BY source_id ORDER BY source_id;")
			.all() as Array<{ sourceId: string; fileCount: number }>;
		const chunkRows = db
			.prepare("SELECT source_id as sourceId, COUNT(*) as chunkCount FROM kb_chunks GROUP BY source_id ORDER BY source_id;")
			.all() as Array<{ sourceId: string; chunkCount: number }>;
		const chunkBySource = new Map(chunkRows.map((row) => [row.sourceId, row.chunkCount]));
		const sourceStats = fileRows.map((row) => ({
			sourceId: row.sourceId,
			fileCount: Number(row.fileCount),
			chunkCount: Number(chunkBySource.get(row.sourceId) ?? 0),
		}));

		const metaRows = db.prepare("SELECT key, value FROM kb_index_meta ORDER BY key;").all() as Array<{ key: string; value: string }>;
		const meta: Record<string, string> = {};
		for (const row of metaRows) meta[row.key] = row.value;

		return { dbPath, exists: true, sourceStats, meta };
	} finally {
		db.close();
	}
}

export function clearKbIndex(dbPath: string, scope: KbIndexScope, sourceIds?: string[]): { dbPath: string; existed: boolean; clearedSources: string[] } {
	if (!fs.existsSync(dbPath)) {
		return { dbPath, existed: false, clearedSources: [] };
	}

	const db = openDb(dbPath);
	try {
		const ids = new Set((sourceIds ?? []).map((s) => s.trim()).filter((s) => s.length > 0));
		if (scope === "all" && ids.size === 0) {
			db.exec("DELETE FROM kb_chunks;");
			db.exec("DELETE FROM indexed_files;");
			db.exec("DELETE FROM kb_index_meta;");
			return { dbPath, existed: true, clearedSources: ["*"] };
		}

		const rows = db.prepare("SELECT DISTINCT source_id as sourceId FROM indexed_files;").all() as Array<{ sourceId: string }>;
		const targets = rows
			.map((r) => r.sourceId)
			.filter((sourceId) => {
				if (ids.size > 0 && !ids.has(sourceId)) return false;
				if (scope === "all") return true;
				if (scope === "project") return /^project[-_:]/i.test(sourceId);
				return /^shared[-_:]/i.test(sourceId);
			});

		for (const sourceId of targets) {
			db.prepare("DELETE FROM kb_chunks WHERE source_id = ?;").run(sourceId);
			db.prepare("DELETE FROM indexed_files WHERE source_id = ?;").run(sourceId);
		}

		return { dbPath, existed: true, clearedSources: targets };
	} finally {
		db.close();
	}
}

function searchKbIndexWithMatchQuery(
	dbPath: string,
	query: string,
	topK: number,
	sourceIds?: string[],
	pathPrefix?: string,
): KbSearchResult {
	if (!fs.existsSync(dbPath)) {
		throw new Error(`KB index not found at ${dbPath}. Run /kb-index update first.`);
	}

	const db = openDb(dbPath);
	try {
		const whereParts: string[] = ["kb_chunks MATCH ?"];
		const params: Array<string | number> = [query];

		const scopedSourceIds = (sourceIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
		if (scopedSourceIds.length > 0) {
			whereParts.push(`source_id IN (${scopedSourceIds.map(() => "?").join(",")})`);
			params.push(...scopedSourceIds);
		}

		const trimmedPathPrefix = pathPrefix?.trim();
		if (trimmedPathPrefix) {
			whereParts.push("file_path LIKE ?");
			params.push(`${trimmedPathPrefix}%`);
		}

		params.push(topK);
		const sql = `
SELECT
	source_id as sourceId,
	file_path as filePath,
	CAST(start_line AS INTEGER) as startLine,
	CAST(end_line AS INTEGER) as endLine,
	text,
	bm25(kb_chunks) as score
FROM kb_chunks
WHERE ${whereParts.join(" AND ")}
ORDER BY score
LIMIT ?;`;

		const rows = db.prepare(sql).all(...params) as Array<{
			sourceId: string;
			filePath: string;
			startLine: number;
			endLine: number;
			text: string;
			score: number;
		}>;

		return {
			dbPath,
			query,
			topK,
			results: rows.map((row) => ({
				sourceId: row.sourceId,
				filePath: row.filePath,
				startLine: Number(row.startLine),
				endLine: Number(row.endLine),
				text: row.text,
				score: Number(row.score),
			})),
		};
	} finally {
		db.close();
	}
}

function toFtsPhraseClause(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error("search clauses must not be empty");
	const escaped = trimmed.replace(/"/g, '""');
	return `"${escaped}"`;
}

function buildUnionMatchQuery(all: string[], any: string[]): string {
	const allClauses = all.map(toFtsPhraseClause);
	const anyClauses = any.map(toFtsPhraseClause);

	if (allClauses.length === 0) {
		throw new Error("kb_union_search requires at least one required clause in all");
	}

	const parts = allClauses.map((clause) => `(${clause})`);
	if (anyClauses.length > 0) {
		parts.push(`(${anyClauses.map((clause) => `(${clause})`).join(" OR ")})`);
	}
	return parts.join(" AND ");
}

export function searchKbIndex(dbPath: string, options: KbSearchOptions): KbSearchResult {
	const query = options.query.trim();
	if (query.length === 0) throw new Error("query must not be empty");
	const topK = Math.max(1, Math.min(50, Math.trunc(options.topK || 8)));
	return searchKbIndexWithMatchQuery(dbPath, query, topK, options.sourceIds, options.pathPrefix);
}

export function searchKbIndexUnion(dbPath: string, options: KbUnionSearchOptions): KbUnionSearchResult {
	const all = (options.all ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
	const any = (options.any ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
	const topK = Math.max(1, Math.min(100, Math.trunc(options.topK || 20)));
	const matchQuery = buildUnionMatchQuery(all, any);
	const result = searchKbIndexWithMatchQuery(dbPath, matchQuery, topK, options.sourceIds, options.pathPrefix);
	return {
		...result,
		all,
		any,
		matchQuery,
	};
}

export function formatKbIndexUpdateResult(result: KbIndexUpdateResult): string {
	const lines: string[] = [];
	lines.push(`KB index updated (${result.scope})`);
	lines.push(`DB: \`${result.dbPath}\``);
	lines.push("");
	for (const source of result.sources) {
		lines.push(`- ${source.sourceId} (${source.rootId})`);
		if (!source.indexed) {
			for (const error of source.errors) lines.push(`  error: ${error}`);
			continue;
		}
		lines.push(
			`  files: discovered=${source.filesDiscovered}, reindexed=${source.filesReindexed}, unchanged=${source.filesUnchanged}, removed=${source.filesRemoved}, skipped=${source.skippedFiles}`,
		);
		lines.push(`  chunksWritten: ${source.chunksWritten}`);
		if (source.errors.length > 0) {
			for (const error of source.errors.slice(0, 20)) lines.push(`  error: ${error}`);
			if (source.errors.length > 20) lines.push(`  ... ${source.errors.length - 20} more errors`);
		}
	}
	return lines.join("\n");
}

export function formatKbIndexStatus(status: { dbPath: string; exists: boolean; sourceStats: Array<{ sourceId: string; fileCount: number; chunkCount: number }>; meta: Record<string, string> }): string {
	if (!status.exists) {
		return `KB index not found at \`${status.dbPath}\`. Run /kb-index update.`;
	}

	const lines: string[] = [];
	lines.push("KB index status");
	lines.push(`DB: \`${status.dbPath}\``);
	lines.push("");
	lines.push(`Sources (${status.sourceStats.length}):`);
	for (const row of status.sourceStats) {
		lines.push(`- ${row.sourceId}: files=${row.fileCount}, chunks=${row.chunkCount}`);
	}
	const metaKeys = Object.keys(status.meta).sort();
	if (metaKeys.length > 0) {
		lines.push("");
		lines.push("Meta:");
		for (const key of metaKeys) lines.push(`- ${key}: ${status.meta[key]}`);
	}
	return lines.join("\n");
}

export function formatKbSearchResult(result: KbSearchResult): string {
	if (result.results.length === 0) {
		return `No local KB matches for query: ${result.query}`;
	}
	const lines: string[] = [];
	lines.push(`Local KB matches for: ${result.query}`);
	lines.push(`DB: \`${result.dbPath}\``);
	lines.push("");
	for (let i = 0; i < result.results.length; i++) {
		const item = result.results[i];
		const snippet = item.text.length > 700 ? `${item.text.slice(0, 699)}…` : item.text;
		lines.push(`${i + 1}. [${item.sourceId}] ${item.filePath}:${item.startLine}-${item.endLine} score=${item.score.toFixed(4)}`);
		lines.push(snippet);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export function formatKbUnionSearchResult(result: KbUnionSearchResult): string {
	if (result.results.length === 0) {
		const anyText = result.any.length > 0 ? ` and ANY(${result.any.join(" | ")})` : "";
		return `No local KB matches for union search: ALL(${result.all.join(", ")})${anyText}`;
	}

	const lines: string[] = [];
	lines.push("Local KB union matches");
	lines.push(`ALL: ${result.all.join(", ")}`);
	if (result.any.length > 0) lines.push(`ANY: ${result.any.join(" | ")}`);
	lines.push(`DB: \`${result.dbPath}\``);
	lines.push("");
	for (let i = 0; i < result.results.length; i++) {
		const item = result.results[i];
		const snippet = item.text.length > 700 ? `${item.text.slice(0, 699)}…` : item.text;
		lines.push(`${i + 1}. [${item.sourceId}] ${item.filePath}:${item.startLine}-${item.endLine} score=${item.score.toFixed(4)}`);
		lines.push(snippet);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
