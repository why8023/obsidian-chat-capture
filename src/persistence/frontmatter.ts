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

export function renderConversationMarkdown(
	snapshot: NormalizedSnapshot,
	entry: SessionIndexEntry,
): string {
	const frontmatter = [
		"---",
		`source: ${yamlScalar(snapshot.source)}`,
		`conversation_key: ${yamlScalar(snapshot.conversationKey)}`,
		`chat_url: ${yamlScalar(snapshot.pageUrl)}`,
		`created_at: ${yamlScalar(new Date(entry.createdAt).toISOString())}`,
		`updated_at: ${yamlScalar(new Date(entry.updatedAt).toISOString())}`,
		`message_count: ${yamlScalar(entry.lastStableMessageCount)}`,
		`extractor_version: ${yamlScalar(snapshot.extractorVersion)}`,
		`page_state: ${yamlScalar(snapshot.pageState)}`,
		"---",
	];

	const content: string[] = [
		frontmatter.join("\n"),
		"",
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
