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
	ConversationNoteEntry,
	NormalizedSnapshot,
	PluginSettings,
	SessionIndexEntry,
} from "../types";
import {
	isSupportedConversationSource,
	readConversationFrontmatterEntry,
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

function extractConversationIdFromUrl(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}

	const match = url.match(/\/c\/([^/?#]+)/i);
	return normalizeString(match?.[1]);
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

function compareEntries(left: ConversationNoteEntry, right: ConversationNoteEntry): number {
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

type ConversationIdentityField =
	| "conversationId"
	| "conversationKey"
	| "provisionalConversationKey";

interface IdentityIndex {
	groups: Map<string, Set<string>>;
	winners: Map<string, ConversationNoteEntry>;
	requireUnique: boolean;
	warnOnDuplicate: boolean;
}

const IDENTITY_FIELDS: readonly ConversationIdentityField[] = [
	"conversationId",
	"conversationKey",
	"provisionalConversationKey",
];

function createIdentityIndex(
	options?: Partial<Pick<IdentityIndex, "requireUnique" | "warnOnDuplicate">>,
): IdentityIndex {
	return {
		groups: new Map<string, Set<string>>(),
		winners: new Map<string, ConversationNoteEntry>(),
		requireUnique: options?.requireUnique ?? false,
		warnOnDuplicate: options?.warnOnDuplicate ?? true,
	};
}

export class ConversationNoteIndex {
	private readonly byFilePath = new Map<string, ConversationNoteEntry>();
	private readonly pendingMetadataPaths = new Set<string>();
	private readonly identityIndexes: Record<ConversationIdentityField, IdentityIndex> = {
		conversationId: createIdentityIndex(),
		conversationKey: createIdentityIndex(),
		provisionalConversationKey: createIdentityIndex({
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

		this.logger.info("Conversation note index rebuilt", {
			count: this.byFilePath.size,
			pendingMetadataCount: this.pendingMetadataPaths.size,
			saveFolders: getTrackedSaveFolders(this.getSettings()),
		});
	}

	hasPendingMetadataFiles(): boolean {
		return this.pendingMetadataPaths.size > 0;
	}

	entries(): ConversationNoteEntry[] {
		return [...this.byFilePath.values()];
	}

	filePaths(): string[] {
		return [...this.byFilePath.keys()];
	}

	findMatch(snapshot: NormalizedSnapshot): ConversationNoteEntry | undefined {
		if (snapshot.conversationId) {
			const byConversationId = this.getIdentityWinner(
				"conversationId",
				snapshot.conversationId,
			);
			if (byConversationId) {
				return byConversationId;
			}
		}

		const byConversationKey = this.getIdentityWinner(
			"conversationKey",
			snapshot.conversationKey,
		);
		if (byConversationKey) {
			return byConversationKey;
		}

		if (snapshot.provisionalConversationKey) {
			return this.getIdentityWinner(
				"provisionalConversationKey",
				snapshot.provisionalConversationKey,
			);
		}

		return undefined;
	}

	hasConversationForUrl(url: string): boolean {
		const conversationId = extractConversationIdFromUrl(url);
		if (
			conversationId &&
			this.getIdentityWinner("conversationId", conversationId)
		) {
			return true;
		}

		for (const entry of this.byFilePath.values()) {
			if (entry.chatUrl === url) {
				return true;
			}
		}

		return false;
	}

	upsertFromSnapshot(snapshot: NormalizedSnapshot, entry: SessionIndexEntry): void {
		this.upsertRecord({
			filePath: entry.filePath,
			conversationId: snapshot.conversationId,
			conversationKey: snapshot.conversationKey,
			provisionalConversationKey: snapshot.provisionalConversationKey,
			chatUrl: snapshot.pageUrl,
			title: snapshot.conversationTitle,
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

	private parseRecord(
		file: TFile,
		cache: CachedMetadata,
	): ConversationNoteEntry | null {
		const frontmatter = cache.frontmatter;
		if (!frontmatter) {
			return null;
		}

		const source = normalizeString(
			readConversationFrontmatterEntry(frontmatter, "source"),
		);
		const conversationKey = normalizeString(
			readConversationFrontmatterEntry(frontmatter, "conversationKey"),
		);
		const chatUrl = normalizeString(
			readConversationFrontmatterEntry(frontmatter, "chatUrl"),
		);
		if (!isSupportedConversationSource(source) || !conversationKey) {
			return null;
		}

		const conversationId =
			normalizeString(readConversationFrontmatterEntry(frontmatter, "conversationId")) ??
			extractConversationIdFromUrl(chatUrl);

		return {
			filePath: file.path,
			conversationId,
			conversationKey,
			provisionalConversationKey: normalizeString(
				readConversationFrontmatterEntry(
					frontmatter,
					"provisionalConversationKey",
				),
			),
			chatUrl,
			title:
				normalizeString(readConversationFrontmatterEntry(frontmatter, "title")) ??
				file.basename,
			createdAt: parseTimestamp(
				readConversationFrontmatterEntry(frontmatter, "createdAt"),
			),
			updatedAt: parseTimestamp(
				readConversationFrontmatterEntry(frontmatter, "updatedAt"),
			),
			messageCount: parseMessageCount(
				readConversationFrontmatterEntry(frontmatter, "messageCount"),
			),
		};
	}

	private upsertRecord(record: ConversationNoteEntry): void {
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

	private indexRecord(record: ConversationNoteEntry): void {
		for (const field of IDENTITY_FIELDS) {
			this.addIdentityValue(field, record[field], record.filePath);
		}
	}

	private deindexRecord(record: ConversationNoteEntry): void {
		for (const field of IDENTITY_FIELDS) {
			this.removeIdentityValue(field, record[field], record.filePath);
		}
	}

	private addIdentityValue(
		field: ConversationIdentityField,
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
		field: ConversationIdentityField,
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

	private refreshIdentityWinner(
		field: ConversationIdentityField,
		key: string,
	): void {
		const index = this.identityIndexes[field];
		const winnerMap = index.winners;
		const candidates = [...(index.groups.get(key) ?? [])]
			.map((filePath) => this.byFilePath.get(filePath))
			.filter((entry): entry is ConversationNoteEntry => Boolean(entry))
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
			this.logger.warn("Conversation note index found duplicate identities", {
				field,
				key,
				kept: winner.filePath,
				discarded: candidates.slice(1).map((entry) => entry.filePath),
			});
		}
	}

	private getIdentityWinner(
		field: ConversationIdentityField,
		key: string,
	): ConversationNoteEntry | undefined {
		return this.identityIndexes[field].winners.get(key);
	}
}
