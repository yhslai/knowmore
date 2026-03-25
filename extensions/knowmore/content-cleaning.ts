import * as path from "node:path";

const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/gi, "'")
		.replace(/&#x2F;/gi, "/")
		.replace(/&#(\d+);/g, (_, code) => {
			const value = Number(code);
			if (!Number.isFinite(value)) return _;
			try {
				return String.fromCodePoint(value);
			} catch {
				return _;
			}
		})
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
			const value = Number.parseInt(hex, 16);
			if (!Number.isFinite(value)) return _;
			try {
				return String.fromCodePoint(value);
			} catch {
				return _;
			}
		});
}

function normalizeTextWhitespace(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\t/g, " ").replace(/[ \u00A0]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function looksLikeHtmlDocument(contentType?: string, filePath?: string): boolean {
	if (typeof contentType === "string" && /\b(html|xhtml)\b/i.test(contentType)) return true;
	if (typeof filePath === "string") {
		const ext = path.extname(filePath).toLowerCase();
		if (HTML_EXTENSIONS.has(ext)) return true;
	}
	return false;
}

/**
 * Extract readable text from HTML while explicitly dropping webpage CSS/JS payloads.
 * This removes <script>, <style>, and <noscript> blocks, but keeps normal document text
 * (including code examples in <pre>/<code> as text content).
 */
export function extractReadableTextFromHtml(html: string): string {
	const withoutWebAssets = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "\n");

	const withBlockBreaks = withoutWebAssets.replace(
		/<\/?(?:p|div|section|article|main|aside|header|footer|nav|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|code|br|hr)[^>]*>/gi,
		"\n",
	);

	const withoutTags = withBlockBreaks
		.replace(/<!--([\s\S]*?)-->/g, " ")
		.replace(/<[^>]+>/g, " ");

	return normalizeTextWhitespace(decodeEntities(withoutTags));
}

export function preprocessDocumentTextForKb(content: string, filePath: string): string {
	if (looksLikeHtmlDocument(undefined, filePath)) {
		return extractReadableTextFromHtml(content);
	}
	return content;
}

export function preprocessDocumentTextForDistiller(content: string, opts: { filePath?: string; contentType?: string }): string {
	if (looksLikeHtmlDocument(opts.contentType, opts.filePath)) {
		return extractReadableTextFromHtml(content);
	}
	return normalizeTextWhitespace(content);
}
