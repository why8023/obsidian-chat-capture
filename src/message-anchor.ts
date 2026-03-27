import { createHash } from "crypto";
import type { ChatMessageRole } from "./types";

export interface MessageAnchorMetadata {
	matchKey: string;
	role: ChatMessageRole;
	contentHtmlHash: string;
}

export const OBAR_RECORD_START_MARKER = "OBAR-RECORD-START";
export const OBAR_RECORD_END_MARKER = "OBAR-RECORD-END";

const MESSAGE_HEADING_PATTERN = /^# (USER|AI)(?::.*)?$/;
const TRAILING_THEMATIC_BREAK_PATTERN = /\n{2,}(?:[-*_]\s*){3,}\s*$/;

export function hashString(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function normalizeMessageText(value: string | undefined): string {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\u00A0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function markdownToPlainText(markdown: string): string {
	return normalizeMessageText(
		String(markdown ?? "")
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
			.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/_([^_]+)_/g, "$1"),
	);
}

export function buildMessageMatchKeyFromTextHash(
	role: ChatMessageRole,
	textHash: string,
): string {
	return `v1|${role}|${textHash}`;
}

export function buildMessageMatchKey(
	role: ChatMessageRole,
	plainText: string,
): string {
	return buildMessageMatchKeyFromTextHash(role, hashString(normalizeMessageText(plainText)));
}

export function parseMessageHeadingRole(
	value: string,
): ChatMessageRole | undefined {
	const firstLine = String(value ?? "").split("\n", 1)[0]?.trim();
	if (!firstLine) {
		return undefined;
	}

	const match = firstLine.match(MESSAGE_HEADING_PATTERN);
	if (!match?.[1]) {
		return undefined;
	}

	return match[1] === "USER" ? "user" : "ai";
}

export function stripLeadingMessageHeading(value: string): string {
	return String(value ?? "").replace(/^\s*# (?:USER|AI)(?::.*)?\n+/, "");
}

export function normalizeMessageMarkdownBody(value: string): string {
	return normalizeMessageText(
		stripLeadingMessageHeading(String(value ?? "")).replace(
			TRAILING_THEMATIC_BREAK_PATTERN,
			"",
		),
	);
}

export function serializeMessageAnchorMetadata(
	metadata: MessageAnchorMetadata,
): string {
	return `<!-- ${OBAR_RECORD_START_MARKER}:${JSON.stringify(metadata)} -->`;
}

export function renderMessageAnchorEnd(): string {
	return `<!-- ${OBAR_RECORD_END_MARKER} -->`;
}

export function parseMessageAnchorMetadata(
	value: string,
): MessageAnchorMetadata | null {
	try {
		const parsed = JSON.parse(value) as Partial<MessageAnchorMetadata>;
		if (
			typeof parsed.matchKey !== "string" ||
			(parsed.role !== "user" &&
				parsed.role !== "ai" &&
				parsed.role !== "system" &&
				parsed.role !== "unknown") ||
			typeof parsed.contentHtmlHash !== "string"
		) {
			return null;
		}

		return {
			matchKey: parsed.matchKey,
			role: parsed.role,
			contentHtmlHash: parsed.contentHtmlHash,
		};
	} catch {
		return null;
	}
}
