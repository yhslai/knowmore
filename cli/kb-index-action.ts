import * as path from "node:path";

import { buildKnowledgeBaseCatalog, ensureKnowledgeBaseReferencesExist } from "../extensions/knowmore/kb.js";
import {
	clearKbIndex,
	formatKbIndexStatus,
	formatKbIndexUpdateResult,
	getKbIndexStatus,
	pickKbIndexPath,
	resolveKbIndexPaths,
	updateKbIndex,
	type KbIndexScope,
} from "../extensions/knowmore/kb-index.js";
import { invalidateKbCatalogCache, loadConfig, resolveScopes, validateKbIndexSourceIds } from "../extensions/knowmore/core.js";

export interface KbIndexActionOptions {
	action: "update" | "status" | "clear";
	scope: KbIndexScope;
	sourceIds?: string[];
	reindex?: boolean;
	onProgress?: (line: string) => void;
}

/** Shared implementation of `/kb-index` for the CLI and the MCP `kb_index` tool. Returns a markdown-ish report. */
export async function runKbIndexAction(cwd: string, options: KbIndexActionOptions): Promise<string> {
	const loaded = loadConfig(cwd);
	const indexPaths = resolveKbIndexPaths(cwd, loaded.projectConfigPath);
	const sourceIds = options.sourceIds && options.sourceIds.length > 0 ? options.sourceIds : undefined;

	const targetScopes = resolveScopes(options.scope).filter((scope) => scope !== "project" || pickKbIndexPath(indexPaths, scope).available);
	if (targetScopes.length === 0) {
		throw new Error(`Project index scope requested but no project knowmore.config.json was found from cwd ${cwd}.`);
	}

	if (options.action === "status") {
		return targetScopes
			.map((scope) => `# ${scope}\n${formatKbIndexStatus(getKbIndexStatus(pickKbIndexPath(indexPaths, scope).dbPath))}`)
			.join("\n\n");
	}

	const catalog = buildKnowledgeBaseCatalog(loaded.config, {
		globalConfigPath: loaded.globalConfigPath,
		projectConfigPath: loaded.projectConfigPath,
	});

	if (options.action === "clear") {
		if (sourceIds) validateKbIndexSourceIds(catalog, options.scope, sourceIds);
		return targetScopes
			.map((scope) => {
				const result = clearKbIndex(pickKbIndexPath(indexPaths, scope).dbPath, scope, sourceIds);
				const summary =
					result.clearedSources.length === 0 ? "none" : result.clearedSources[0] === "*" ? "all" : `${result.clearedSources.length} source(s)`;
				return `KB index cleared (${scope}: ${summary})\nDB: \`${result.dbPath}\``;
			})
			.join("\n\n");
	}

	ensureKnowledgeBaseReferencesExist(catalog);
	validateKbIndexSourceIds(catalog, options.scope, sourceIds);
	const reports: string[] = [];
	for (const scope of targetScopes) {
		const updated = await updateKbIndex(pickKbIndexPath(indexPaths, scope).dbPath, catalog, {
			scope,
			sourceIds,
			reindex: options.reindex,
			onSourceStart: (event) =>
				options.onProgress?.(`[${scope}] source ${event.sourceIndex}/${event.totalSources}: ${event.sourceId} (${event.sourcePath})`),
			onFileProgress: (event) => {
				if (event.fileIndex % 200 === 0 || event.fileIndex === event.totalFiles) {
					options.onProgress?.(`[${scope}] ${event.sourceId}: ${event.phase} ${event.fileIndex}/${event.totalFiles} ${path.basename(event.filePath)}`);
				}
			},
		});
		reports.push(`# ${scope}\n${formatKbIndexUpdateResult(updated)}`);
	}
	invalidateKbCatalogCache();
	return reports.join("\n\n");
}
