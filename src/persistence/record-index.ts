import {
	TAbstractFile,
	TFile,
	TFolder,
	type App,
	type CachedMetadata,
} from "obsidian";
import { Logger } from "../debug/logger";
import { getTrackedSaveFolders } from "../settings/chat-targets";
import type {
	NormalizedSessionSnapshot,
	PluginSettings,
	RecordEntry,
	SessionIndexEntry,
} from "../types";
import {
	isSupportedRecordSource,
	readRecordFrontmatterEntry,
} from "./frontmatter";

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function parseMessageCount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.round(value));
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : undefined;
}

function extractSessionIdFromUrl(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}

	const match = url.match(/\/c\/([^/?#]+)/i);
	return normalizeString(match?.[1]);
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

function compareEntries(left: RecordEntry, right: RecordEntry): number {
	if ((left.updatedAt ?? 0) !== (right.updatedAt ?? 0)) {
		return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
	}
	if ((left.createdAt ?? 0) !== (right.createdAt ?? 0)) {
		return (right.createdAt ?? 0) - (left.createdAt ?? 0);
	}
	if ((left.messageCount ?? 0) !== (right.messageCount ?? 0)) {
		return (right.messageCount ?? 0) - (left.messageCount ?? 0);
	}
	return left.filePath.localeCompare(right.filePath);
}

type SessionIdentityField = "sessionId" | "sessionKey" | "provisionalSessionKey";

interface IdentityIndex {
	groups: Map<string, Set<string>>;
	winners: Map<string, RecordEntry>;
	requireUnique: boolean;
	warnOnDuplicate: boolean;
}

const IDENTITY_FIELDS: readonly SessionIdentityField[] = [
	"sessionId",
	"sessionKey",
	"provisionalSessionKey",
];

function createIdentityIndex(
	options?: Partial<Pick<IdentityIndex, "requireUnique" | "warnOnDuplicate">>,
): IdentityIndex {
	return {
		groups: new Map<string, Set<string>>(),
		winners: new Map<string, RecordEntry>(),
		requireUnique: options?.requireUnique ?? false,
		warnOnDuplicate: options?.warnOnDuplicate ?? true,
	};
}

export class RecordIndex {
	private readonly byFilePath = new Map<string, RecordEntry>();
	private readonly pendingMetadataPaths = new Set<string>();
	private readonly identityIndexes: Record<SessionIdentityField, IdentityIndex> = {
		sessionId: createIdentityIndex(),
		sessionKey: createIdentityIndex(),
		provisionalSessionKey: createIdentityIndex({
			requireUnique: true,
			warnOnDuplicate: false,
		}),
	};

	constructor(
		private readonly app: App,
		private readonly getSettings: () => PluginSettings,
		private readonly logger: Logger,
	) {}

	async rebuild(): Promise<void> {
		this.byFilePath.clear();
		this.pendingMetadataPaths.clear();
		this.clearIdentityIndexes();

		for (const file of this.collectTrackedMarkdownFiles()) {
			this.reindexFile(file);
		}

		this.logger.info("Record index rebuilt", {
			count: this.byFilePath.size,
			pendingMetadataCount: this.pendingMetadataPaths.size,
			saveFolders: getTrackedSaveFolders(this.getSettings()),
		});
	}

	hasPendingMetadataFiles(): boolean {
		return this.pendingMetadataPaths.size > 0;
	}

	entries(): RecordEntry[] {
		return [...this.byFilePath.values()];
	}

	filePaths(): string[] {
		return [...this.byFilePath.keys()];
	}

	findMatch(snapshot: NormalizedSessionSnapshot): RecordEntry | undefined {
		if (snapshot.sessionId) {
			const bySessionId = this.getIdentityWinner("sessionId", snapshot.sessionId);
			if (bySessionId) {
				return bySessionId;
			}
		}

		const bySessionKey = this.getIdentityWinner("sessionKey", snapshot.sessionKey);
		if (bySessionKey) {
			return bySessionKey;
		}

		if (snapshot.provisionalSessionKey) {
			return this.getIdentityWinner(
				"provisionalSessionKey",
				snapshot.provisionalSessionKey,
			);
		}

		return undefined;
	}

	hasRecordForUrl(url: string): boolean {
		const sessionId = extractSessionIdFromUrl(url);
		if (sessionId && this.getIdentityWinner("sessionId", sessionId)) {
			return true;
		}

		for (const entry of this.byFilePath.values()) {
			if (entry.sessionUrl === url) {
				return true;
			}
		}

		return false;
	}

	upsertFromSession(
		snapshot: NormalizedSessionSnapshot,
		entry: SessionIndexEntry,
	): void {
		this.upsertRecord({
			filePath: entry.filePath,
			sessionId: snapshot.sessionId,
			sessionKey: snapshot.sessionKey,
			provisionalSessionKey: snapshot.provisionalSessionKey,
			sessionUrl: snapshot.pageUrl,
			sessionTitle: snapshot.sessionTitle,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			messageCount: entry.lastStableMessageCount,
		});
	}

	handleVaultTouch(file: TAbstractFile): void {
		if (file instanceof TFolder) {
			if (!this.isTrackedPath(file.path)) {
				this.removePathTree(file.path);
				return;
			}

			for (const child of this.collectMarkdownFilesFromFolder(file)) {
				this.reindexFile(child);
			}
			return;
		}

		if (!isMarkdownFile(file)) {
			return;
		}

		if (!this.isTrackedPath(file.path)) {
			this.removePath(file.path);
			return;
		}

		this.reindexFile(file);
	}

	handleVaultRename(file: TAbstractFile, oldPath: string): void {
		this.removePathTree(oldPath);
		this.handleVaultTouch(file);
	}

	handleVaultDelete(file: TAbstractFile): void {
		this.removePathTree(file.path);
	}

	handleMetadataChanged(file: TFile, cache: CachedMetadata): void {
		if (!this.isTrackedPath(file.path)) {
			this.removePath(file.path);
			return;
		}

		this.upsertOrRemoveFromCache(file, cache);
	}

	handleMetadataDeleted(file: TFile): void {
		this.removePath(file.path);
	}

	private collectTrackedMarkdownFiles(): TFile[] {
		const trackedFolders = getTrackedSaveFolders(this.getSettings());
		if (trackedFolders.length === 0) {
			return [];
		}

		const collected = new Map<string, TFile>();
		let foundExistingRoot = false;

		for (const folder of trackedFolders) {
			const root = this.app.vault.getFolderByPath(folder);
			if (!root) {
				continue;
			}

			foundExistingRoot = true;
			for (const file of this.collectMarkdownFilesFromFolder(root)) {
				collected.set(file.path, file);
			}
		}

		if (!foundExistingRoot) {
			return this.app.vault
				.getMarkdownFiles()
				.filter((file) => this.isTrackedPath(file.path));
		}

		return [...collected.values()];
	}

	private collectMarkdownFilesFromFolder(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				files.push(...this.collectMarkdownFilesFromFolder(child));
				continue;
			}
			if (isMarkdownFile(child)) {
				files.push(child);
			}
		}
		return files;
	}

	private isTrackedPath(path: string): boolean {
		return getTrackedSaveFolders(this.getSettings()).some(
			(folder) => path === folder || path.startsWith(`${folder}/`),
		);
	}

	private reindexFile(file: TFile): void {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) {
			this.pendingMetadataPaths.add(file.path);
			return;
		}

		this.upsertOrRemoveFromCache(file, cache);
	}

	private upsertOrRemoveFromCache(file: TFile, cache: CachedMetadata): void {
		this.pendingMetadataPaths.delete(file.path);
		const record = this.parseRecord(file, cache);
		if (record) {
			this.upsertRecord(record);
			return;
		}

		this.removePath(file.path);
	}

	private parseRecord(file: TFile, cache: CachedMetadata): RecordEntry | null {
		const frontmatter = cache.frontmatter;
		if (!frontmatter) {
			return null;
		}

		const source = normalizeString(readRecordFrontmatterEntry(frontmatter, "source"));
		const sessionKey = normalizeString(
			readRecordFrontmatterEntry(frontmatter, "sessionKey"),
		);
		const sessionUrl = normalizeString(
			readRecordFrontmatterEntry(frontmatter, "sessionUrl"),
		);
		if (!isSupportedRecordSource(source) || !sessionKey) {
			return null;
		}

		const sessionId =
			normalizeString(readRecordFrontmatterEntry(frontmatter, "sessionId")) ??
			extractSessionIdFromUrl(sessionUrl);

		return {
			filePath: file.path,
			sessionId,
			sessionKey,
			provisionalSessionKey: normalizeString(
				readRecordFrontmatterEntry(frontmatter, "provisionalSessionKey"),
			),
			sessionUrl,
			sessionTitle:
				normalizeString(readRecordFrontmatterEntry(frontmatter, "sessionTitle")) ??
				file.basename,
			createdAt: parseTimestamp(readRecordFrontmatterEntry(frontmatter, "createdAt")),
			updatedAt: parseTimestamp(readRecordFrontmatterEntry(frontmatter, "updatedAt")),
			messageCount: parseMessageCount(
				readRecordFrontmatterEntry(frontmatter, "messageCount"),
			),
		};
	}

	private upsertRecord(record: RecordEntry): void {
		this.removePath(record.filePath);
		this.byFilePath.set(record.filePath, record);
		this.indexRecord(record);
	}

	private removePath(path: string): void {
		const previous = this.byFilePath.get(path);
		this.pendingMetadataPaths.delete(path);
		if (!previous) {
			return;
		}

		this.byFilePath.delete(path);
		this.deindexRecord(previous);
	}

	private removePathTree(path: string): void {
		const candidates = [
			...this.byFilePath.keys(),
			...[...this.pendingMetadataPaths].filter(
				(candidatePath) =>
					candidatePath === path || candidatePath.startsWith(`${path}/`),
			),
		].filter(
			(candidatePath, index, values) =>
				values.indexOf(candidatePath) === index &&
				(candidatePath === path || candidatePath.startsWith(`${path}/`)),
		);
		candidates.forEach((candidatePath) => this.removePath(candidatePath));
	}

	private clearIdentityIndexes(): void {
		for (const field of IDENTITY_FIELDS) {
			this.identityIndexes[field].groups.clear();
			this.identityIndexes[field].winners.clear();
		}
	}

	private indexRecord(record: RecordEntry): void {
		for (const field of IDENTITY_FIELDS) {
			this.addIdentityValue(field, record[field], record.filePath);
		}
	}

	private deindexRecord(record: RecordEntry): void {
		for (const field of IDENTITY_FIELDS) {
			this.removeIdentityValue(field, record[field], record.filePath);
		}
	}

	private addIdentityValue(
		field: SessionIdentityField,
		key: string | undefined,
		filePath: string,
	): void {
		if (!key) {
			return;
		}

		const index = this.identityIndexes[field];
		const filePaths = index.groups.get(key) ?? new Set<string>();
		filePaths.add(filePath);
		index.groups.set(key, filePaths);
		this.refreshIdentityWinner(field, key);
	}

	private removeIdentityValue(
		field: SessionIdentityField,
		key: string | undefined,
		filePath: string,
	): void {
		if (!key) {
			return;
		}

		const index = this.identityIndexes[field];
		const filePaths = index.groups.get(key);
		if (!filePaths) {
			return;
		}

		filePaths.delete(filePath);
		if (filePaths.size === 0) {
			index.groups.delete(key);
		}
		this.refreshIdentityWinner(field, key);
	}

	private refreshIdentityWinner(field: SessionIdentityField, key: string): void {
		const index = this.identityIndexes[field];
		const winnerMap = index.winners;
		const candidates = [...(index.groups.get(key) ?? [])]
			.map((filePath) => this.byFilePath.get(filePath))
			.filter((entry): entry is RecordEntry => Boolean(entry))
			.sort(compareEntries);

		if (candidates.length === 0) {
			winnerMap.delete(key);
			return;
		}

		if (index.requireUnique && candidates.length !== 1) {
			winnerMap.delete(key);
			return;
		}

		const winner = candidates[0];
		if (!winner) {
			winnerMap.delete(key);
			return;
		}
		const previous = winnerMap.get(key);
		winnerMap.set(key, winner);
		if (
			index.warnOnDuplicate &&
			candidates.length > 1 &&
			(!previous || previous.filePath !== winner.filePath)
		) {
			this.logger.warn("Record index found duplicate session identities", {
				field,
				key,
				kept: winner.filePath,
				discarded: candidates.slice(1).map((entry) => entry.filePath),
			});
		}
	}

	private getIdentityWinner(field: SessionIdentityField, key: string): RecordEntry | undefined {
		return this.identityIndexes[field].winners.get(key);
	}
}
