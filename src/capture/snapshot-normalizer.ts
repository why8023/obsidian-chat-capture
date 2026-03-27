import { createHash } from "crypto";
import { OBAR_CAPTURE_SOURCE } from "../constants";
import { buildMessageMatchKey } from "../message-anchor";
import { DefuddleAdapter } from "./defuddle-adapter";
import type {
	ChatMessageRole,
	NormalizedMessage,
	PageState,
	NormalizedSessionSnapshot,
	SessionSnapshot,
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
		case "ai":
		case "system":
			return role;
		case "assistant":
			return "ai";
		default:
			return "unknown";
	}
}

function normalizePageState(state: string | undefined): PageState {
	switch (state) {
		case "login":
		case "chat-list":
		case "session":
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

function extractSessionId(snapshot: SessionSnapshot): string {
	const direct = normalizeText(snapshot.sessionId);
	if (direct) {
		return direct;
	}

	const match = snapshot.pageUrl.match(/\/c\/([^/?#]+)/i);
	return normalizeText(match?.[1] ?? "");
}

function normalizeSessionTitle(snapshot: SessionSnapshot, firstUserText: string): string {
	const pageTitle = normalizeText(snapshot.pageTitle.replace(/\s+-\s+ChatGPT$/i, ""));
	return (
		normalizeText(snapshot.sessionTitle) ||
		pageTitle ||
		normalizeText(firstUserText).slice(0, 80) ||
		"Untitled session"
	);
}

export class SnapshotNormalizer {
	constructor(private readonly defuddleAdapter = new DefuddleAdapter()) {}

	async normalize(snapshot: SessionSnapshot): Promise<NormalizedSessionSnapshot> {
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
			const matchKey = buildMessageMatchKey(role, text);
			const uid = hashString(
				[String(index + 1), role, domKey, previousUid].join("|"),
			);
			const actionFlags = normalizeActionFlags(turn.actionFlags);

			normalizedMessages.push({
				uid,
				matchKey,
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
		const sessionTitle = normalizeSessionTitle(
			snapshot,
			firstUserMessage?.text ?? "",
		);
		const sessionId = extractSessionId(snapshot);
		const firstUserTextHash = firstUserMessage?.textHash ?? "";
		const sessionKey = sessionId
			? hashString(`session-id|${sessionId}`)
			: hashString(`${snapshot.pageUrl}|${sessionTitle}|${firstUserTextHash}`);
		const snapshotHash = hashString(
			[
				sessionKey,
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
			sessionId: sessionId || undefined,
			sessionKey,
			sessionTitle,
			pageUrl: snapshot.pageUrl,
			pageTitle: normalizeText(snapshot.pageTitle),
			capturedAt: Number.isNaN(capturedAt) ? Date.now() : capturedAt,
			pageState: normalizePageState(snapshot.pageState),
			messages: normalizedMessages,
			snapshotHash,
		};
	}
}
