import type {
	NormalizedMessage,
	NormalizedSnapshot,
	PluginStateData,
	SessionIndexEntry,
	SessionMessageIndex,
} from "../types";

export interface PreparedSessionMerge {
	entry: SessionIndexEntry;
	changed: boolean;
	created: boolean;
	replaceAll: boolean;
	newMessages: NormalizedMessage[];
	replacedKeys: string[];
	skipReason?: string;
}

interface SessionEntryMatch {
	key: string;
	entry: SessionIndexEntry;
}

function toSessionMessages(messages: NormalizedMessage[]): SessionMessageIndex[] {
	return messages.map((message) => ({
		uid: message.uid,
		ordinal: message.ordinal,
		role: message.role,
		textHash: message.textHash,
	}));
}

function countSharedPrefix(
	existing: SessionMessageIndex[],
	incoming: NormalizedMessage[],
): number {
	let count = 0;
	while (count < existing.length && count < incoming.length) {
		const existingMessage = existing[count];
		const incomingMessage = incoming[count];
		if (!existingMessage || !incomingMessage) {
			break;
		}
		if (
			existingMessage.uid !== incomingMessage.uid ||
			existingMessage.textHash !== incomingMessage.textHash
		) {
			break;
		}
		count += 1;
	}
	return count;
}

function compareSessionMatches(left: SessionEntryMatch, right: SessionEntryMatch): number {
	if (left.entry.lastStableMessageCount !== right.entry.lastStableMessageCount) {
		return right.entry.lastStableMessageCount - left.entry.lastStableMessageCount;
	}
	if (left.entry.updatedAt !== right.entry.updatedAt) {
		return right.entry.updatedAt - left.entry.updatedAt;
	}
	return right.entry.createdAt - left.entry.createdAt;
}

export class SessionIndex {
	constructor(
		private readonly state: PluginStateData,
		private readonly persistState: () => Promise<void>,
	) {}

	get(conversationKey: string): SessionIndexEntry | undefined {
		return this.state.sessions[conversationKey];
	}

	entries(): SessionIndexEntry[] {
		return Object.values(this.state.sessions);
	}

	private findMatchesBySourceUrl(sourceUrl: string): SessionEntryMatch[] {
		return Object.entries(this.state.sessions)
			.filter(([, entry]) => entry.sourceUrl === sourceUrl)
			.map(([key, entry]) => ({ key, entry }))
			.sort(compareSessionMatches);
	}

	prepare(snapshot: NormalizedSnapshot, filePath: string): PreparedSessionMerge {
		const exactMatch = this.state.sessions[snapshot.conversationKey];
		const sourceUrlMatches = this.findMatchesBySourceUrl(snapshot.pageUrl);
		const existingMatch = exactMatch
			? { key: snapshot.conversationKey, entry: exactMatch }
			: sourceUrlMatches[0];
		const existing = existingMatch?.entry;
		const replacedKeys = sourceUrlMatches
			.map((match) => match.key)
			.filter((key) => key !== snapshot.conversationKey);
		const nextEntry: SessionIndexEntry = {
			conversationKey: snapshot.conversationKey,
			filePath: existing?.filePath ?? filePath,
			sourceUrl: snapshot.pageUrl,
			title: snapshot.conversationTitle,
			createdAt: existing?.createdAt ?? snapshot.capturedAt,
			updatedAt: snapshot.capturedAt,
			lastStableMessageCount: snapshot.messages.length,
			lastSnapshotHash: snapshot.snapshotHash,
			messages: toSessionMessages(snapshot.messages),
		};

		if (!existing) {
			return {
				entry: nextEntry,
				changed: true,
				created: true,
				replaceAll: true,
				newMessages: snapshot.messages,
				replacedKeys,
			};
		}

		if (
			existing.lastSnapshotHash === nextEntry.lastSnapshotHash &&
			existing.title === nextEntry.title &&
			existing.sourceUrl === nextEntry.sourceUrl
		) {
			return {
				entry: nextEntry,
				changed: false,
				created: false,
				replaceAll: false,
				newMessages: [],
				replacedKeys,
			};
		}

		if (snapshot.messages.length < existing.messages.length) {
			return {
				entry: {
					...existing,
					conversationKey: snapshot.conversationKey,
				},
				changed: false,
				created: false,
				replaceAll: false,
				newMessages: [],
				replacedKeys,
				skipReason: "snapshot-shorter-than-stored",
			};
		}

		const sharedPrefix = countSharedPrefix(existing.messages, snapshot.messages);
		const replaceAll = sharedPrefix < existing.messages.length;

		return {
			entry: nextEntry,
			changed: true,
			created: false,
			replaceAll,
			newMessages: replaceAll ? snapshot.messages : snapshot.messages.slice(sharedPrefix),
			replacedKeys,
		};
	}

	async commit(entry: SessionIndexEntry, replacedKeys: string[] = []): Promise<void> {
		for (const key of replacedKeys) {
			if (key !== entry.conversationKey) {
				delete this.state.sessions[key];
			}
		}
		this.state.sessions[entry.conversationKey] = entry;
		await this.persistState();
	}
}
