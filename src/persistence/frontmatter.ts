import { parseFrontMatterEntry, type FrontMatterCache } from "obsidian";
import type {
	ChatMessageRole,
	NormalizedMessage,
	NormalizedSnapshot,
	SessionIndexEntry,
} from "../types";

const LEGACY_CONVERSATION_FRONTMATTER_KEYS = {
	source: "source",
	conversationKey: "conversation_key",
	chatUrl: "chat_url",
	createdAt: "created_at",
	updatedAt: "updated_at",
	messageCount: "message_count",
	extractorVersion: "extractor_version",
	pageState: "page_state",
	conversationId: "conversation_id",
} as const;

const LEGACY_CONVERSATION_SOURCE = "chatgpt-webviewer";
export const OBAR_CONVERSATION_SOURCE = "obar-chatgpt-webviewer";

export const OBAR_CONVERSATION_FRONTMATTER_KEYS = {
	source: "obar_source",
	conversationKey: "obar_conversation_key",
	chatUrl: "obar_chat_url",
	createdAt: "obar_created_at",
	updatedAt: "obar_updated_at",
	messageCount: "obar_message_count",
	extractorVersion: "obar_extractor_version",
	pageState: "obar_page_state",
	conversationId: "obar_conversation_id",
} as const;

type ConversationFrontmatterField = keyof typeof OBAR_CONVERSATION_FRONTMATTER_KEYS;

const CONVERSATION_FRONTMATTER_KEY_FALLBACKS: Record<
	ConversationFrontmatterField,
	readonly string[]
> = {
	source: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.source,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.source,
	],
	conversationKey: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.conversationKey,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.conversationKey,
	],
	chatUrl: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.chatUrl,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.chatUrl,
	],
	createdAt: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.createdAt,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.createdAt,
	],
	updatedAt: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.updatedAt,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.updatedAt,
	],
	messageCount: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.messageCount,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.messageCount,
	],
	extractorVersion: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.extractorVersion,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.extractorVersion,
	],
	pageState: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.pageState,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.pageState,
	],
	conversationId: [
		OBAR_CONVERSATION_FRONTMATTER_KEYS.conversationId,
		LEGACY_CONVERSATION_FRONTMATTER_KEYS.conversationId,
	],
};

const CANONICAL_CONVERSATION_FRONTMATTER_ORDER: ConversationFrontmatterField[] = [
	"source",
	"conversationId",
	"conversationKey",
	"chatUrl",
	"createdAt",
	"updatedAt",
	"messageCount",
	"extractorVersion",
	"pageState",
];

const LEGACY_KEY_TO_FIELD = Object.fromEntries(
	Object.entries(CONVERSATION_FRONTMATTER_KEY_FALLBACKS).flatMap(([field, keys]) =>
		keys.map((key) => [key, field]),
	),
) as Record<string, ConversationFrontmatterField>;

function yamlScalar(value: number | string): string {
	if (typeof value === "number") {
		return String(value);
	}

	return JSON.stringify(value);
}

function headingForRole(role: ChatMessageRole): string {
	switch (role) {
		case "user":
			return "User";
		case "assistant":
			return "Assistant";
		case "system":
			return "System";
		default:
			return "Unknown";
	}
}

function normalizeLegacyValue(value: string): string {
	if (!value) {
		return "";
	}

	return /^\s/.test(value) ? value : ` ${value.trimStart()}`;
}

function readYamlScalarString(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(trimmed);
		return typeof parsed === "string" ? parsed : String(parsed);
	} catch {
		// Fall back to plain text or single-quoted YAML scalars.
	}

	const singleQuoted = trimmed.match(/^'(.*)'$/);
	if (singleQuoted) {
		return (singleQuoted[1] ?? "").replace(/''/g, "'");
	}

	return trimmed;
}

function parseFrontmatterLine(line: string): { key: string; value: string } | null {
	const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
	if (!match) {
		return null;
	}

	return {
		key: match[1] ?? "",
		value: match[2] ?? "",
	};
}

export function getConversationFrontmatterKey(
	field: ConversationFrontmatterField,
): string {
	return OBAR_CONVERSATION_FRONTMATTER_KEYS[field];
}

export function readConversationFrontmatterEntry(
	frontmatter: FrontMatterCache,
	field: ConversationFrontmatterField,
): unknown {
	for (const key of CONVERSATION_FRONTMATTER_KEY_FALLBACKS[field]) {
		const value = parseFrontMatterEntry(frontmatter, key);
		if (value !== undefined && value !== null) {
			return value;
		}
	}

	return undefined;
}

export function isSupportedConversationSource(value: string | undefined): boolean {
	return value === OBAR_CONVERSATION_SOURCE || value === LEGACY_CONVERSATION_SOURCE;
}

export function renderMessageMarkdown(message: NormalizedMessage): string {
	const lines: string[] = [`## ${headingForRole(message.role)}`];

	if (message.markdown) {
		lines.push(message.markdown);
	} else if (message.text) {
		lines.push(message.text);
	}

	return lines.join("\n");
}

export function buildConversationFrontmatter(
	snapshot: NormalizedSnapshot,
	entry: SessionIndexEntry,
): Record<string, number | string> {
	const frontmatter: Record<string, number | string> = {
		[getConversationFrontmatterKey("source")]: snapshot.source,
		[getConversationFrontmatterKey("conversationKey")]: snapshot.conversationKey,
		[getConversationFrontmatterKey("chatUrl")]: snapshot.pageUrl,
		[getConversationFrontmatterKey("createdAt")]: new Date(entry.createdAt).toISOString(),
		[getConversationFrontmatterKey("updatedAt")]: new Date(entry.updatedAt).toISOString(),
		[getConversationFrontmatterKey("messageCount")]: entry.lastStableMessageCount,
		[getConversationFrontmatterKey("extractorVersion")]: snapshot.extractorVersion,
		[getConversationFrontmatterKey("pageState")]: snapshot.pageState,
	};

	if (snapshot.conversationId) {
		frontmatter[getConversationFrontmatterKey("conversationId")] =
			snapshot.conversationId;
	}

	return frontmatter;
}

export function renderConversationBody(
	snapshot: NormalizedSnapshot,
): string {
	const content: string[] = [
		`# ${snapshot.conversationTitle || snapshot.pageTitle || "Untitled conversation"}`,
		"",
	];

	snapshot.messages.forEach((message, index) => {
		content.push(renderMessageMarkdown(message));
		if (index < snapshot.messages.length - 1) {
			content.push("");
		}
	});

	return `${content.join("\n").trimEnd()}\n`;
}

export function renderConversationMarkdown(
	snapshot: NormalizedSnapshot,
	entry: SessionIndexEntry,
): string {
	const frontmatter = Object.entries(buildConversationFrontmatter(snapshot, entry)).map(
		([key, value]) => `${key}: ${yamlScalar(value)}`,
	);

	return [
		"---",
		...frontmatter,
		"---",
		"",
		renderConversationBody(snapshot).trimEnd(),
		"",
	].join("\n");
}

export function migrateConversationFrontmatter(content: string): string | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
	if (!match) {
		return null;
	}

	const newline = match[0].includes("\r\n") ? "\r\n" : "\n";
	const currentBlock = (match[1] ?? "").split(/\r?\n/);
	const trailingBreak = match[2] ?? "";
	const passthroughLines: string[] = [];
	const values = new Map<ConversationFrontmatterField, string>();
	let recognized = false;

	for (const line of currentBlock) {
		const parsed = parseFrontmatterLine(line);
		if (!parsed) {
			passthroughLines.push(line);
			continue;
		}

		const field = LEGACY_KEY_TO_FIELD[parsed.key];
		if (!field) {
			passthroughLines.push(line);
			continue;
		}

		recognized = true;
		if (!values.has(field) || parsed.key.startsWith("obar_")) {
			values.set(field, normalizeLegacyValue(parsed.value));
		}
	}

	if (!recognized) {
		return null;
	}

	const source = readYamlScalarString(values.get("source"));
	const conversationKey = readYamlScalarString(values.get("conversationKey"));
	if (!conversationKey && !isSupportedConversationSource(source)) {
		return null;
	}

	values.set("source", ` ${JSON.stringify(OBAR_CONVERSATION_SOURCE)}`);

	const canonicalLines = CANONICAL_CONVERSATION_FRONTMATTER_ORDER.flatMap((field) => {
		const value = values.get(field);
		return value ? [`${getConversationFrontmatterKey(field)}:${value}`] : [];
	});

	const migratedBlock = ["---", ...canonicalLines, ...passthroughLines, "---"].join(
		newline,
	);
	const migratedContent = `${migratedBlock}${trailingBreak}${content.slice(match[0].length)}`;

	return migratedContent === content ? null : migratedContent;
}
