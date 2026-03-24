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
	skipReason?: string;
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

	prepare(snapshot: NormalizedSnapshot, filePath: string): PreparedSessionMerge {
		const existing = this.state.sessions[snapshot.conversationKey];
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
			};
		}

		if (
			existing.lastSnapshotHash === nextEntry.lastSnapshotHash &&
			existing.title === nextEntry.title &&
			existing.sourceUrl === nextEntry.sourceUrl
		) {
			return {
				entry: existing,
				changed: false,
				created: false,
				replaceAll: false,
				newMessages: [],
			};
		}

		if (snapshot.messages.length < existing.messages.length) {
			return {
				entry: existing,
				changed: false,
				created: false,
				replaceAll: false,
				newMessages: [],
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
		};
	}

	async commit(entry: SessionIndexEntry): Promise<void> {
		this.state.sessions[entry.conversationKey] = entry;
		await this.persistState();
	}
}
