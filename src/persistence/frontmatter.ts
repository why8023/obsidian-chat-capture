import type {
	ChatMessageRole,
	NormalizedMessage,
	NormalizedSnapshot,
	SessionIndexEntry,
} from "../types";

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
		source: snapshot.source,
		conversation_key: snapshot.conversationKey,
		chat_url: snapshot.pageUrl,
		created_at: new Date(entry.createdAt).toISOString(),
		updated_at: new Date(entry.updatedAt).toISOString(),
		message_count: entry.lastStableMessageCount,
		extractor_version: snapshot.extractorVersion,
		page_state: snapshot.pageState,
	};

	if (snapshot.conversationId) {
		frontmatter.conversation_id = snapshot.conversationId;
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
