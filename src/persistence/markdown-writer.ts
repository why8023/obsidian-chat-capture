import { TFile, type App } from "obsidian";
import { Logger } from "../debug/logger";
import type { NormalizedSnapshot, PluginSettings, SessionIndexEntry } from "../types";
import { buildConversationFilePath } from "./file-path";
import {
	migrateConversationFrontmatter,
	renderConversationMarkdown,
} from "./frontmatter";

function appendSuffixToPath(path: string, suffix: string): string {
	return path.replace(/\.md$/i, ` ${suffix}.md`);
}

export class MarkdownWriter {
	constructor(
		private readonly app: App,
		private readonly getSettings: () => PluginSettings,
		private readonly logger: Logger,
	) {}

	async resolveFilePath(
		snapshot: NormalizedSnapshot,
		existingPaths: string[],
	): Promise<string> {
		const reservedPaths = new Set(existingPaths);
		const basePath = buildConversationFilePath(this.getSettings(), snapshot);
		let candidate = basePath;
		let attempt = 0;

		while (true) {
			const existing = this.app.vault.getAbstractFileByPath(candidate);
			if (!existing && !reservedPaths.has(candidate)) {
				return candidate;
			}

			attempt += 1;
			const suffix =
				attempt === 1
					? snapshot.conversationKey.slice(0, 8)
					: `${snapshot.conversationKey.slice(0, 8)}-${attempt}`;
			candidate = appendSuffixToPath(basePath, suffix);
		}
	}

	async writeSnapshot(
		snapshot: NormalizedSnapshot,
		entry: SessionIndexEntry,
	): Promise<TFile> {
		const content = renderConversationMarkdown(snapshot, entry, this.getSettings());
		await this.ensureFolder(entry.filePath);

		const existing = this.app.vault.getAbstractFileByPath(entry.filePath);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => content);
			this.logger.info("Conversation note written", {
				filePath: entry.filePath,
				messageCount: entry.lastStableMessageCount,
			});
			return existing;
		}

		const file = await this.app.vault.create(entry.filePath, content);

		this.logger.info("Conversation note written", {
			filePath: entry.filePath,
			messageCount: entry.lastStableMessageCount,
		});
		return file;
	}

	async migrateLegacyFrontmatter(filePath: string): Promise<boolean> {
		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (!(existing instanceof TFile)) {
			return false;
		}

		let migrated = false;
		await this.app.vault.process(existing, (content) => {
			const nextContent = migrateConversationFrontmatter(content);
			if (!nextContent) {
				return content;
			}

			migrated = true;
			return nextContent;
		});

		if (migrated) {
			this.logger.info("Migrated conversation note frontmatter to OBAR", {
				filePath,
			});
		}

		return migrated;
	}

	private async ensureFolder(filePath: string): Promise<void> {
		const folderPath = filePath.split("/").slice(0, -1).join("/");
		if (!folderPath) {
			return;
		}

		const parts = folderPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}
