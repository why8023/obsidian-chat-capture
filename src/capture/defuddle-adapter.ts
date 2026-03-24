import { createHash } from "crypto";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import type { RawTurnShell } from "../types";

export interface ParsedTurnContent {
	markdown: string;
	text: string;
}

function hashString(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string | undefined): string {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\u00A0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function normalizeMarkdown(value: string | undefined): string {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\u00A0/g, " ")
		.trim();
}

function markdownToPlainText(markdown: string): string {
	return normalizeText(
		markdown
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/^>\s?/gm, "")
			.replace(/^\s*[-*+]\s+/gm, "")
			.replace(/^\s*\d+\.\s+/gm, "")
			.replace(/```[\s\S]*?```/g, (block) =>
				block
					.replace(/^```[^\n]*\n?/, "")
					.replace(/\n?```$/, ""),
			)
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
			.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/_([^_]+)_/g, "$1"),
	);
}

function buildSyntheticDocument(contentHtml: string): string {
	return [
		"<!DOCTYPE html>",
		"<html>",
		"<head><meta charset=\"utf-8\"></head>",
		"<body>",
		"<article data-obsidian-chat-capture-content=\"1\">",
		contentHtml,
		"</article>",
		"</body>",
		"</html>",
	].join("");
}

type ComputedStyleLike = Pick<CSSStyleDeclaration, "display" | "visibility">;
type MaybeWindowWithComputedStyle = {
	getComputedStyle?: (element: Element) => ComputedStyleLike;
};

function createSyntheticComputedStyle(): ComputedStyleLike {
	return {
		display: "",
		visibility: "",
	};
}

async function withPatchedComputedStyle<T>(
	document: Document,
	run: () => Promise<T>,
): Promise<T> {
	const defaultView = document.defaultView as MaybeWindowWithComputedStyle | null;
	if (!defaultView) {
		return await run();
	}

	const originalGetComputedStyle = defaultView.getComputedStyle;
	defaultView.getComputedStyle = (element: Element) => {
		if (element.ownerDocument === document) {
			return createSyntheticComputedStyle();
		}

		if (typeof originalGetComputedStyle === "function") {
			return originalGetComputedStyle(element);
		}

		return createSyntheticComputedStyle();
	};

	try {
		return await run();
	} finally {
		if (typeof originalGetComputedStyle === "function") {
			defaultView.getComputedStyle = originalGetComputedStyle;
		} else {
			delete defaultView.getComputedStyle;
		}
	}
}

export class DefuddleAdapter {
	private readonly cache = new Map<string, ParsedTurnContent | Promise<ParsedTurnContent>>();
	private readonly maxCacheEntries = 500;

	async parseTurn(turn: RawTurnShell, pageUrl: string): Promise<ParsedTurnContent> {
		const cacheKey = normalizeText(turn.contentHtmlHash) || hashString(turn.contentHtml);
		const existing = this.cache.get(cacheKey);
		if (existing) {
			return await existing;
		}

		const pending = this.parseTurnInternal(turn, pageUrl);
		this.cache.set(cacheKey, pending);

		try {
			const parsed = await pending;
			this.cache.set(cacheKey, parsed);
			this.pruneCache();
			return parsed;
		} catch (error) {
			this.cache.delete(cacheKey);
			throw error;
		}
	}

	private async parseTurnInternal(
		turn: RawTurnShell,
		pageUrl: string,
	): Promise<ParsedTurnContent> {
		const fallbackText = normalizeText(turn.contentTextHint);
		const html = buildSyntheticDocument(turn.contentHtml);
		const { document } = parseHTML(html);
		const fallbackDocumentText = normalizeText(
			document.querySelector("[data-obsidian-chat-capture-content='1']")?.textContent ?? "",
		);
		const text = fallbackText || fallbackDocumentText;

		try {
			const result = await withPatchedComputedStyle(document, async () =>
				await Defuddle(document, pageUrl, {
					markdown: true,
					separateMarkdown: true,
					useAsync: false,
					includeReplies: false,
					contentSelector: "[data-obsidian-chat-capture-content='1']",
				}),
			);
			const markdown = normalizeMarkdown(result.contentMarkdown ?? result.content);
			if (markdown) {
				return {
					markdown,
					text: text || markdownToPlainText(markdown),
				};
			}
		} catch {
			// Fall back to plain text so a single parse failure does not stop capture.
		}

		return {
			markdown: text,
			text,
		};
	}

	private pruneCache(): void {
		if (this.cache.size <= this.maxCacheEntries) {
			return;
		}

		const oldestEntry = this.cache.keys().next();
		if (!oldestEntry.done) {
			this.cache.delete(oldestEntry.value);
		}
	}
}
