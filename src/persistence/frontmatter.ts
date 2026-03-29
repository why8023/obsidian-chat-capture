import { parseFrontMatterEntry, type FrontMatterCache } from "obsidian";
import {
	renderMessageAnchorEnd,
	serializeMessageAnchorMetadata,
} from "../message-anchor";
import type {
	ChatMessageRole,
	NormalizedMessage,
	NormalizedSessionSnapshot,
	PluginSettings,
	SessionIndexEntry,
} from "../types";
import { formatLocalTimestamp } from "./date-format";
import { shiftMarkdownFirstLevelHeadings } from "./markdown-heading-shifter";

export const OBAR_RECORD_SOURCE = "obar-chatgpt-webviewer";

export const OBAR_RECORD_FRONTMATTER_KEYS = {
	source: "obar_source",
	sessionKey: "obar_session_key",
	sessionTitle: "obar_session_title",
	sessionUrl: "obar_session_url",
	createdAt: "obar_record_created_at",
	updatedAt: "obar_record_updated_at",
	messageCount: "obar_record_message_count",
	extractorVersion: "obar_extractor_version",
	pageState: "obar_session_state",
	sessionId: "obar_session_id",
} as const;

type RecordFrontmatterField = keyof typeof OBAR_RECORD_FRONTMATTER_KEYS;

function yamlScalar(value: number | string): string {
	if (typeof value === "number") {
		return String(value);
	}

	return JSON.stringify(value);
}

function headingForRole(role: ChatMessageRole): string {
	switch (role) {
		case "user":
			return "USER";
		default:
			return "AI";
	}
}

function sanitizeHeadingSummary(value: string): string {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\u00A0/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.replace(/^(?:>\s*)+/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(/^(`{3,}|~{3,})[^\s]*\s*/i, "")
		.replace(/\s+#{1,6}$/, "")
		.replace(/\s*(`{3,}|~{3,})$/, "")
		.trim();
}

function truncateHeadingSummary(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength).trimEnd()}...`;
}

function buildMessageHeading(
	message: NormalizedMessage,
	maxSummaryLength: number,
): string {
	const roleHeading = headingForRole(message.role);
	const summary = truncateHeadingSummary(
		sanitizeHeadingSummary(message.text || message.markdown),
		maxSummaryLength,
	);

	return summary ? `${roleHeading}: ${summary}` : roleHeading;
}

function renderMessageContent(message: NormalizedMessage): string {
	const content = message.markdown || message.text;
	if (!content) {
		return "";
	}

	return shiftMarkdownFirstLevelHeadings(content, 1);
}

export function getRecordFrontmatterKey(field: RecordFrontmatterField): string {
	return OBAR_RECORD_FRONTMATTER_KEYS[field];
}

export function readRecordFrontmatterEntry(
	frontmatter: FrontMatterCache,
	field: RecordFrontmatterField,
): unknown {
	return parseFrontMatterEntry(frontmatter, getRecordFrontmatterKey(field));
}

export function isSupportedRecordSource(value: string | undefined): boolean {
	return value === OBAR_RECORD_SOURCE;
}

export function renderMessageMarkdown(
	message: NormalizedMessage,
	settings: Pick<PluginSettings, "messageHeadingSummaryLength">,
): string {
	const content = renderMessageContent(message);
	return content
		? [
				`# ${buildMessageHeading(message, settings.messageHeadingSummaryLength)}`,
				content,
			].join("\n\n")
		: `# ${buildMessageHeading(message, settings.messageHeadingSummaryLength)}`;
}

function renderMessageBlock(
	message: NormalizedMessage,
	settings: Pick<PluginSettings, "messageHeadingSummaryLength">,
): string {
	return [
		serializeMessageAnchorMetadata({
			matchKey: message.matchKey,
			role: message.role,
			contentHtmlHash: message.contentHtmlHash,
		}),
		renderMessageMarkdown(message, settings),
		renderMessageAnchorEnd(),
	].join("\n");
}

export function buildRecordFrontmatter(
	snapshot: NormalizedSessionSnapshot,
	entry: SessionIndexEntry,
): Record<string, number | string> {
	const frontmatter: Record<string, number | string> = {
		[getRecordFrontmatterKey("source")]: snapshot.source,
		[getRecordFrontmatterKey("sessionKey")]: snapshot.sessionKey,
		[getRecordFrontmatterKey("sessionTitle")]:
			entry.sessionTitle || snapshot.sessionTitle,
		[getRecordFrontmatterKey("sessionUrl")]: snapshot.pageUrl,
		[getRecordFrontmatterKey("createdAt")]: formatLocalTimestamp(entry.createdAt),
		[getRecordFrontmatterKey("updatedAt")]: formatLocalTimestamp(entry.updatedAt),
		[getRecordFrontmatterKey("messageCount")]: entry.lastStableMessageCount,
		[getRecordFrontmatterKey("extractorVersion")]: snapshot.extractorVersion,
		[getRecordFrontmatterKey("pageState")]: snapshot.pageState,
	};

	if (snapshot.sessionId) {
		frontmatter[getRecordFrontmatterKey("sessionId")] = snapshot.sessionId;
	}

	return frontmatter;
}

export function renderRecordBody(
	snapshot: NormalizedSessionSnapshot,
	settings: Pick<PluginSettings, "messageHeadingSummaryLength">,
): string {
	const blocks = snapshot.messages.map((message) =>
		renderMessageBlock(message, settings),
	);
	return `${blocks.join("\n\n").trimEnd()}\n`;
}

export function renderRecordMarkdown(
	snapshot: NormalizedSessionSnapshot,
	entry: SessionIndexEntry,
	settings: Pick<PluginSettings, "messageHeadingSummaryLength">,
): string {
	const frontmatter = Object.entries(buildRecordFrontmatter(snapshot, entry)).map(
		([key, value]) => `${key}: ${yamlScalar(value)}`,
	);

	return [
		"---",
		...frontmatter,
		"---",
		"",
		renderRecordBody(snapshot, settings).trimEnd(),
		"",
	].join("\n");
}
