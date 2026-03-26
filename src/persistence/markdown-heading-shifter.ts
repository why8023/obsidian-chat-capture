import type { Heading, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

interface MarkdownReplacement {
	start: number;
	end: number;
	value: string;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function buildAtxHeading(source: string, depth: number): string {
	const match = source.match(/^( {0,3})(#{1,6})(?=(?:[ \t]|$))/);
	if (!match) {
		return source;
	}

	const indent = match[1] ?? "";
	const hashes = match[2] ?? "";
	return `${indent}${"#".repeat(Math.min(6, depth))}${source.slice(
		indent.length + hashes.length,
	)}`;
}

function buildSetextHeading(source: string, depth: number): string {
	const lines = source.split("\n");
	if (lines.length < 2) {
		return source;
	}

	const contentLines = lines.slice(0, -1);
	const indent = contentLines
		.find((line) => line.trim().length > 0)
		?.match(/^( {0,3})/)?.[1] ?? "";
	const content = contentLines.map((line) => line.trim()).join(" ").trim();
	if (!content) {
		return source;
	}

	return `${indent}${"#".repeat(Math.min(6, depth))} ${content}`;
}

function shiftHeadingSource(source: string, depthDelta: number): string {
	const atxMatch = source.match(/^( {0,3})(#{1,6})(?=(?:[ \t]|$))/);
	if (atxMatch) {
		const currentDepth = (atxMatch[2] ?? "").length;
		return buildAtxHeading(source, currentDepth + depthDelta);
	}

	return buildSetextHeading(source, 1 + depthDelta);
}

function collectFirstLevelHeadingReplacements(
	markdown: string,
	depthDelta: number,
): MarkdownReplacement[] {
	const tree = markdownParser.parse(markdown) as Root;
	const replacements: MarkdownReplacement[] = [];

	visit(tree, "heading", (node: Heading) => {
		if (node.depth !== 1) {
			return;
		}

		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (
			typeof start !== "number" ||
			typeof end !== "number" ||
			start < 0 ||
			end <= start
		) {
			return;
		}

		const source = markdown.slice(start, end);
		const value = shiftHeadingSource(source, depthDelta);
		if (value !== source) {
			replacements.push({ start, end, value });
		}
	});

	return replacements;
}

export function shiftMarkdownFirstLevelHeadings(
	markdown: string,
	depthDelta: number,
): string {
	if (!markdown || depthDelta <= 0) {
		return markdown;
	}

	try {
		const replacements = collectFirstLevelHeadingReplacements(markdown, depthDelta);
		if (replacements.length === 0) {
			return markdown;
		}

		let result = markdown;
		for (let index = replacements.length - 1; index >= 0; index -= 1) {
			const replacement = replacements[index];
			if (!replacement) {
				continue;
			}

			result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(
				replacement.end,
			)}`;
		}

		return result;
	} catch {
		return markdown;
	}
}
