import {
	TAbstractFile,
	TFile,
	TFolder,
	type App,
	type CachedMetadata,
	parseFrontMatterEntry,
} from "obsidian";
import { Logger } from "../debug/logger";
import type {
	ConversationNoteEntry,
	NormalizedSnapshot,
	PluginSettings,
	SessionIndexEntry,
} from "../types";

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

export class ConversationNoteIndex {
	private readonly byFilePath = new Map<string, ConversationNoteEntry>();
	private readonly byConversationId = new Map<string, ConversationNoteEntry>();
	private readonly byConversationKey = new Map<string, ConversationNoteEntry>();

	constructor(
		private readonly app: App,
		private readonly getSettings: () => PluginSettings,
		private readonly logger: Logger,
	) {}

	async rebuild(): Promise<void> {
		this.byFilePath.clear();
		this.byConversationId.clear();
		this.byConversationKey.clear();

		for (const file of this.collectTrackedMarkdownFiles()) {
			this.reindexFile(file);
		}

		this.logger.info("Conversation note index rebuilt", {
			count: this.byFilePath.size,
			saveFolder: this.getSettings().saveFolder,
		});
	}

	entries(): ConversationNoteEntry[] {
		return [...this.byFilePath.values()];
	}

	filePaths(): string[] {
		return [...this.byFilePath.keys()];
	}

	findMatch(snapshot: NormalizedSnapshot): ConversationNoteEntry | undefined {
		if (snapshot.conversationId) {
			const byConversationId = this.byConversationId.get(snapshot.conversationId);
			if (byConversationId) {
				return byConversationId;
			}
		}

		return this.byConversationKey.get(snapshot.conversationKey);
	}

	hasConversationForUrl(url: string): boolean {
		const conversationId = extractConversationIdFromUrl(url);
		if (conversationId && this.byConversationId.has(conversationId)) {
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
		const root = this.app.vault.getFolderByPath(this.getSettings().saveFolder);
		if (!root) {
			return this.app.vault
				.getMarkdownFiles()
				.filter((file) => this.isTrackedPath(file.path));
		}

		return this.collectMarkdownFilesFromFolder(root);
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
		const folder = this.getSettings().saveFolder;
		return path === folder || path.startsWith(`${folder}/`);
	}

	private reindexFile(file: TFile): void {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) {
			return;
		}

		this.upsertOrRemoveFromCache(file, cache);
	}

	private upsertOrRemoveFromCache(file: TFile, cache: CachedMetadata): void {
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

		const source = normalizeString(parseFrontMatterEntry(frontmatter, "source"));
		const conversationKey = normalizeString(
			parseFrontMatterEntry(frontmatter, "conversation_key"),
		);
		const chatUrl = normalizeString(parseFrontMatterEntry(frontmatter, "chat_url"));
		if (source !== "chatgpt-webviewer" || !conversationKey) {
			return null;
		}

		const conversationId =
			normalizeString(parseFrontMatterEntry(frontmatter, "conversation_id")) ??
			extractConversationIdFromUrl(chatUrl);

		return {
			filePath: file.path,
			conversationId,
			conversationKey,
			chatUrl,
			title: file.basename,
			createdAt: parseTimestamp(parseFrontMatterEntry(frontmatter, "created_at")),
			updatedAt: parseTimestamp(parseFrontMatterEntry(frontmatter, "updated_at")),
			messageCount: parseMessageCount(parseFrontMatterEntry(frontmatter, "message_count")),
		};
	}

	private upsertRecord(record: ConversationNoteEntry): void {
		this.removePath(record.filePath);
		this.byFilePath.set(record.filePath, record);
		this.refreshIdentity(record.conversationId, this.byConversationId);
		this.refreshIdentity(record.conversationKey, this.byConversationKey);
	}

	private removePath(path: string): void {
		const previous = this.byFilePath.get(path);
		if (!previous) {
			return;
		}

		this.byFilePath.delete(path);
		this.refreshIdentity(previous.conversationId, this.byConversationId);
		this.refreshIdentity(previous.conversationKey, this.byConversationKey);
	}

	private removePathTree(path: string): void {
		const candidates = [...this.byFilePath.keys()].filter(
			(candidatePath) =>
				candidatePath === path || candidatePath.startsWith(`${path}/`),
		);
		candidates.forEach((candidatePath) => this.removePath(candidatePath));
	}

	private refreshIdentity(
		key: string | undefined,
		map: Map<string, ConversationNoteEntry>,
	): void {
		if (!key) {
			return;
		}

		const matches = [...this.byFilePath.values()]
			.filter((entry) => this.getIdentityValue(entry, map) === key)
			.sort(compareEntries);
		const winner = matches[0];
		if (winner) {
			const previous = map.get(key);
			map.set(key, winner);
			if (previous && previous.filePath !== winner.filePath) {
				this.logger.warn("Conversation note index found duplicate identities", {
					key,
					kept: winner.filePath,
					discarded: previous.filePath,
				});
			}
			return;
		}

		map.delete(key);
	}

	private getIdentityValue(
		entry: ConversationNoteEntry,
		map: Map<string, ConversationNoteEntry>,
	): string | undefined {
		return map === this.byConversationId
			? entry.conversationId
			: entry.conversationKey;
	}
}
