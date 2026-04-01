import type {
	RecordEntry,
	NormalizedMessage,
	NormalizedSessionSnapshot,
	SessionIndexEntry,
	SessionMessageIndex,
} from "../types";

export interface PreparedSessionMerge {
	entry: SessionIndexEntry;
	changed: boolean;
	created: boolean;
	newMessageCount: number;
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
	private readonly sessions: Record<string, SessionIndexEntry> = {};

	get(sessionKey: string): SessionIndexEntry | undefined {
		return this.sessions[sessionKey];
	}

	findMatch(snapshot: Pick<NormalizedSessionSnapshot, "sessionKey">): SessionIndexEntry | undefined {
		return this.sessions[snapshot.sessionKey];
	}

	entries(): SessionIndexEntry[] {
		return Object.values(this.sessions);
	}

	forgetPathTree(path: string): void {
		for (const [key, entry] of Object.entries(this.sessions)) {
			if (
				entry.filePath === path ||
				entry.filePath.startsWith(`${path}/`)
			) {
				delete this.sessions[key];
			}
		}
	}

	private findMatchesBySessionUrl(sessionUrl: string): SessionEntryMatch[] {
		return Object.entries(this.sessions)
			.filter(([, entry]) => entry.sessionUrl === sessionUrl)
			.map(([key, entry]) => ({ key, entry }))
			.sort(compareSessionMatches);
	}

	private findMatchesByFilePath(filePath: string): SessionEntryMatch[] {
		return Object.entries(this.sessions)
			.filter(([, entry]) => entry.filePath === filePath)
			.map(([key, entry]) => ({ key, entry }))
			.sort(compareSessionMatches);
	}

	private createEntryFromRecord(
		record: RecordEntry,
		snapshot: NormalizedSessionSnapshot,
		filePath: string,
	): SessionIndexEntry {
		return {
			sessionKey: snapshot.sessionKey,
			filePath: record.filePath || filePath,
			sessionUrl: record.sessionUrl ?? snapshot.pageUrl,
			sessionTitle: record.sessionTitle ?? snapshot.sessionTitle,
			createdAt: record.createdAt ?? snapshot.capturedAt,
			updatedAt: record.updatedAt ?? snapshot.capturedAt,
			lastStableMessageCount: record.messageCount ?? 0,
			lastSnapshotHash: "",
			messages: [],
		};
	}

	prepare(
		snapshot: NormalizedSessionSnapshot,
		filePath: string,
		existingRecord?: RecordEntry,
	): PreparedSessionMerge {
		const exactMatch = this.sessions[snapshot.sessionKey];
		const filePathMatches = this.findMatchesByFilePath(filePath);
		const sessionUrlMatches = this.findMatchesBySessionUrl(snapshot.pageUrl);
		const existingMatch = exactMatch
			? { key: snapshot.sessionKey, entry: exactMatch }
			: filePathMatches[0] ?? sessionUrlMatches[0];
		const existing =
			existingMatch?.entry ??
			(existingRecord
				? this.createEntryFromRecord(existingRecord, snapshot, filePath)
				: undefined);
		const replacedKeys = [
			...filePathMatches,
			...sessionUrlMatches,
		]
			.map((match) => match.key)
			.filter((key) => key !== snapshot.sessionKey)
			.filter((key, index, keys) => keys.indexOf(key) === index);
		const nextEntry: SessionIndexEntry = {
			sessionKey: snapshot.sessionKey,
			filePath: existing?.filePath ?? filePath,
			sessionUrl: snapshot.pageUrl,
			sessionTitle: snapshot.sessionTitle,
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
				newMessageCount: snapshot.messages.length,
				replacedKeys,
			};
		}

		if (
			existing.lastSnapshotHash === nextEntry.lastSnapshotHash &&
			existing.sessionTitle === nextEntry.sessionTitle &&
			existing.sessionUrl === nextEntry.sessionUrl
		) {
			return {
				entry: nextEntry,
				changed: false,
				created: false,
				newMessageCount: 0,
				replacedKeys,
			};
		}

		if (snapshot.messages.length < existing.messages.length) {
			return {
				entry: {
					...existing,
					sessionKey: snapshot.sessionKey,
				},
				changed: false,
				created: false,
				newMessageCount: 0,
				replacedKeys,
				skipReason: "snapshot-shorter-than-stored",
			};
		}

		const sharedPrefix = countSharedPrefix(existing.messages, snapshot.messages);
		const newMessageCount =
			sharedPrefix < existing.messages.length
				? snapshot.messages.length
				: snapshot.messages.length - sharedPrefix;

		return {
			entry: nextEntry,
			changed: true,
			created: false,
			newMessageCount,
			replacedKeys,
		};
	}

	async commit(entry: SessionIndexEntry, replacedKeys: string[] = []): Promise<void> {
		for (const key of replacedKeys) {
			if (key !== entry.sessionKey) {
				delete this.sessions[key];
			}
		}
		this.sessions[entry.sessionKey] = entry;
	}
}
