import { createHash } from "crypto";
import type {
	ChatMessageRole,
	CodeBlock,
	ConversationSnapshot,
	NormalizedMessage,
	NormalizedSnapshot,
	PageState,
} from "../types";

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

function normalizeRole(role: string | undefined): ChatMessageRole {
	switch (role) {
		case "user":
		case "assistant":
		case "system":
			return role;
		default:
			return "unknown";
	}
}

function normalizePageState(state: string | undefined): PageState {
	switch (state) {
		case "login":
		case "chat-list":
		case "conversation":
			return state;
		default:
			return "unknown";
	}
}

function normalizeCodeBlocks(blocks?: CodeBlock[]): CodeBlock[] {
	return (blocks ?? [])
		.map((block) => ({
			language: normalizeText(block.language),
			code: normalizeText(block.code),
		}))
		.filter((block) => block.code.length > 0);
}

export class SnapshotNormalizer {
	normalize(snapshot: ConversationSnapshot): NormalizedSnapshot {
		const normalizedMessages: NormalizedMessage[] = [];

		for (const [index, message] of snapshot.messages.entries()) {
			const role = normalizeRole(message.role);
			const text = normalizeText(message.text || message.markdownApprox);
			const codeBlocks = normalizeCodeBlocks(message.codeBlocks);
			if (!text && codeBlocks.length === 0) {
				continue;
			}

			const previousUid = normalizedMessages.at(-1)?.uid ?? "";
			const textHash = hashString(
				[text, ...codeBlocks.map((block) => `${block.language ?? ""}\n${block.code}`)].join(
					"\n\n",
				),
			);
			const uid = hashString(
				[
					String(index + 1),
					role,
					text,
					codeBlocks.map((block) => `${block.language ?? ""}:${block.code}`).join("|"),
					previousUid,
				].join("|"),
			);

			normalizedMessages.push({
				uid,
				ordinal: normalizedMessages.length + 1,
				role,
				text,
				textHash,
				codeBlocks,
				rawHtmlSnippet: normalizeText(message.rawHtmlSnippet),
				nodeFingerprint: normalizeText(message.nodeFingerprint),
				hasCompletionActions: message.hasCompletionActions ?? false,
			});
		}

		const firstUserTextHash =
			normalizedMessages.find((message) => message.role === "user")?.textHash ?? "";
		const conversationTitle =
			normalizeText(snapshot.conversationTitle) ||
			normalizeText(snapshot.pageTitle.replace(/\s+-\s+ChatGPT$/i, "")) ||
			"Untitled conversation";
		const conversationKey =
			normalizeText(snapshot.conversationKey) ||
			hashString(`${snapshot.pageUrl}|${conversationTitle}|${firstUserTextHash}`);
		const snapshotHash = hashString(
			[
				conversationKey,
				snapshot.pageUrl,
				...normalizedMessages.map(
					(message) =>
						`${message.uid}|${message.textHash}|${message.codeBlocks
							.map((block) => `${block.language ?? ""}:${block.code}`)
							.join("||")}`,
				),
			].join("::"),
		);
		const capturedAt = Date.parse(snapshot.capturedAt);

		return {
			source: "chatgpt-webviewer",
			extractorVersion: snapshot.extractorVersion,
			conversationKey,
			conversationTitle,
			pageUrl: snapshot.pageUrl,
			pageTitle: normalizeText(snapshot.pageTitle),
			capturedAt: Number.isNaN(capturedAt) ? Date.now() : capturedAt,
			pageState: normalizePageState(snapshot.pageState),
			messages: normalizedMessages,
			snapshotHash,
		};
	}
}
