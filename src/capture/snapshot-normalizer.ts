import { createHash } from "crypto";
import { OBAR_CAPTURE_SOURCE } from "../constants";
import { DefuddleAdapter } from "./defuddle-adapter";
import type {
	ChatMessageRole,
	ConversationSnapshot,
	NormalizedMessage,
	NormalizedSnapshot,
	PageState,
	TurnActionFlags,
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

function normalizeMarkdown(value: string | undefined): string {
	return String(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\u00A0/g, " ")
		.trim();
}

function normalizeSnippet(value: string | undefined): string {
	return String(value ?? "").replace(/\r\n/g, "\n").trim();
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

function normalizeActionFlags(flags?: Partial<TurnActionFlags>): TurnActionFlags {
	return {
		hasCopyButton: flags?.hasCopyButton ?? false,
		hasThumbActions: flags?.hasThumbActions ?? false,
	};
}

function extractConversationId(snapshot: ConversationSnapshot): string {
	const direct = normalizeText(snapshot.conversationId);
	if (direct) {
		return direct;
	}

	const match = snapshot.pageUrl.match(/\/c\/([^/?#]+)/i);
	return normalizeText(match?.[1] ?? "");
}

function normalizeConversationTitle(snapshot: ConversationSnapshot, firstUserText: string): string {
	const pageTitle = normalizeText(snapshot.pageTitle.replace(/\s+-\s+ChatGPT$/i, ""));
	return (
		normalizeText(snapshot.conversationTitle) ||
		pageTitle ||
		normalizeText(firstUserText).slice(0, 80) ||
		"Untitled conversation"
	);
}

export class SnapshotNormalizer {
	constructor(private readonly defuddleAdapter = new DefuddleAdapter()) {}

	async normalize(snapshot: ConversationSnapshot): Promise<NormalizedSnapshot> {
		const normalizedMessages: NormalizedMessage[] = [];

		for (const [index, turn] of snapshot.turns.entries()) {
			const role = normalizeRole(turn.role);
			const parsed = await this.defuddleAdapter.parseTurn(turn, snapshot.pageUrl);
			const markdown = normalizeMarkdown(parsed.markdown);
			const text = normalizeText(parsed.text || markdown);
			if (!markdown && !text) {
				continue;
			}

			const previousUid = normalizedMessages.at(-1)?.uid ?? "";
			const domKey =
				normalizeText(turn.domKey) ||
				hashString(`${role}|${turn.contentHtmlHash ?? ""}|${index + 1}`);
			const contentHtmlHash =
				normalizeText(turn.contentHtmlHash) || hashString(turn.contentHtml);
			const textHash = hashString(markdown || text);
			const uid = hashString(
				[String(index + 1), role, domKey, previousUid].join("|"),
			);
			const actionFlags = normalizeActionFlags(turn.actionFlags);

			normalizedMessages.push({
				uid,
				ordinal: normalizedMessages.length + 1,
				role,
				text,
				markdown: markdown || text,
				textHash,
				domKey,
				contentHtmlHash,
				rawHtmlSnippet: normalizeSnippet(turn.rawHtmlSnippet),
				actionFlags,
				hasCompletionActions:
					actionFlags.hasCopyButton || actionFlags.hasThumbActions,
			});
		}

		const firstUserMessage = normalizedMessages.find((message) => message.role === "user");
		const conversationTitle = normalizeConversationTitle(
			snapshot,
			firstUserMessage?.text ?? "",
		);
		const conversationId = extractConversationId(snapshot);
		const firstUserTextHash = firstUserMessage?.textHash ?? "";
		const conversationKey = conversationId
			? hashString(`conversation-id|${conversationId}`)
			: hashString(`${snapshot.pageUrl}|${conversationTitle}|${firstUserTextHash}`);
		const snapshotHash = hashString(
			[
				conversationKey,
				snapshot.pageUrl,
				...normalizedMessages.map(
					(message) => `${message.uid}|${message.textHash}|${message.domKey}`,
				),
			].join("::"),
		);
		const capturedAt = Date.parse(snapshot.capturedAt);

		return {
			source: OBAR_CAPTURE_SOURCE,
			extractorVersion: snapshot.extractorVersion,
			conversationId: conversationId || undefined,
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
