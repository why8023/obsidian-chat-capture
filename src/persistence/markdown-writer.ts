import { TFile, type App } from "obsidian";
import { Logger } from "../debug/logger";
import type { NormalizedSnapshot, PluginSettings, SessionIndexEntry } from "../types";
import {
	buildConversationFilePath,
	type ConversationFilePathSource,
} from "./file-path";
import { mergeConversationMarkdownWithCustomNotes } from "./custom-note-blocks";
import { renderConversationMarkdown } from "./frontmatter";

const UTC_FRONTMATTER_TIMESTAMP_PATTERN =
	/^(?:obar_created_at|obar_updated_at|created_at|updated_at):\s*(?:"[^"\n]*Z"|[^"\n]*Z)\s*$/m;

function appendSuffixToPath(path: string, suffix: string): string {
	return path.replace(/\.md$/i, ` ${suffix}.md`);
}

function stripMarkdownExtension(path: string): string {
	return path.replace(/\.md$/i, "");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
		return this.resolveAvailableFilePath(snapshot, existingPaths);
	}

	async reconcileManagedFilePath(
		snapshot: NormalizedSnapshot,
		entry: SessionIndexEntry,
		previousTitle: string | undefined,
		existingPaths: string[],
	): Promise<string> {
		const existing = this.app.vault.getAbstractFileByPath(entry.filePath);
		if (!(existing instanceof TFile)) {
			return entry.filePath;
		}

		const currentPath = existing.path;
		const suffix = this.extractManagedSuffix(
			currentPath,
			snapshot,
			previousTitle,
			entry.createdAt,
		);
		if (suffix === null) {
			return entry.filePath;
		}

		const nextPath = this.resolveAvailableFilePath(snapshot, existingPaths, {
			capturedAt: entry.createdAt,
			title: snapshot.conversationTitle,
			preferredSuffix: suffix,
			ignorePath: currentPath,
		});
		if (nextPath === currentPath) {
			return currentPath;
		}

		await this.ensureFolder(nextPath);
		await this.app.fileManager.renameFile(existing, nextPath);
		this.logger.info("Conversation note renamed", {
			from: currentPath,
			to: nextPath,
			title: snapshot.conversationTitle,
		});
		return nextPath;
	}

	async writeSnapshot(
		snapshot: NormalizedSnapshot,
		entry: SessionIndexEntry,
	): Promise<TFile> {
		const content = renderConversationMarkdown(snapshot, entry, this.getSettings());
		await this.ensureFolder(entry.filePath);

		const existing = this.app.vault.getAbstractFileByPath(entry.filePath);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, (current) =>
				mergeConversationMarkdownWithCustomNotes({
					existingContent: current,
					renderedContent: content,
				}),
			);
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

	async needsFrontmatterTimestampRewrite(filePath: string): Promise<boolean> {
		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (!(existing instanceof TFile)) {
			return false;
		}

		const content = await this.app.vault.cachedRead(existing);
		const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/m)?.[1];
		return frontmatter ? UTC_FRONTMATTER_TIMESTAMP_PATTERN.test(frontmatter) : false;
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

	private resolveAvailableFilePath(
		snapshot: NormalizedSnapshot,
		existingPaths: string[],
		options?: {
			capturedAt?: number;
			title?: string;
			preferredSuffix?: string;
			ignorePath?: string;
		},
	): string {
		const reservedPaths = new Set(
			existingPaths.filter((path) => path !== options?.ignorePath),
		);
		const source = this.createPathSource(
			snapshot,
			options?.title ?? snapshot.conversationTitle,
			options?.capturedAt ?? snapshot.capturedAt,
		);
		const basePath = buildConversationFilePath(this.getSettings(), source);
		const preferredPath =
			options?.preferredSuffix !== undefined
				? buildConversationFilePath(this.getSettings(), source, options.preferredSuffix)
				: basePath;

		if (this.isPathAvailable(preferredPath, reservedPaths, options?.ignorePath)) {
			return preferredPath;
		}
		if (preferredPath !== basePath && this.isPathAvailable(basePath, reservedPaths, options?.ignorePath)) {
			return basePath;
		}

		let attempt = 0;
		while (true) {
			attempt += 1;
			const suffix =
				attempt === 1
					? snapshot.conversationKey.slice(0, 8)
					: `${snapshot.conversationKey.slice(0, 8)}-${attempt}`;
			const candidate = appendSuffixToPath(basePath, suffix);
			if (this.isPathAvailable(candidate, reservedPaths, options?.ignorePath)) {
				return candidate;
			}
		}
	}

	private isPathAvailable(
		candidate: string,
		reservedPaths: Set<string>,
		ignorePath?: string,
	): boolean {
		if (candidate === ignorePath) {
			return true;
		}

		const existing = this.app.vault.getAbstractFileByPath(candidate);
		return !existing && !reservedPaths.has(candidate);
	}

	private extractManagedSuffix(
		currentPath: string,
		snapshot: NormalizedSnapshot,
		title: string | undefined,
		capturedAt: number,
	): string | null {
		if (title) {
			const explicitSuffix = this.extractManagedSuffixForTitle(
				currentPath,
				snapshot,
				title,
				capturedAt,
			);
			if (explicitSuffix !== null) {
				return explicitSuffix;
			}
		}

		return this.extractManagedSuffixFromTemplate(currentPath, snapshot, capturedAt);
	}

	private extractManagedSuffixForTitle(
		currentPath: string,
		snapshot: NormalizedSnapshot,
		title: string,
		capturedAt: number,
	): string | null {
		const basePath = buildConversationFilePath(
			this.getSettings(),
			this.createPathSource(snapshot, title, capturedAt),
		);
		if (currentPath === basePath) {
			return "";
		}

		const suffixMatch = stripMarkdownExtension(currentPath).match(
			new RegExp(
				`^${escapeRegExp(stripMarkdownExtension(basePath))} (${escapeRegExp(
					snapshot.conversationKey.slice(0, 8),
				)}(?:-\\d+)?)$`,
			),
		);
		return suffixMatch?.[1] ?? null;
	}

	private extractManagedSuffixFromTemplate(
		currentPath: string,
		snapshot: NormalizedSnapshot,
		capturedAt: number,
	): string | null {
		const titleMarker = "OBARTITLEMARKER";
		const managedSuffixPattern = `${escapeRegExp(
			snapshot.conversationKey.slice(0, 8),
		)}(?:-\\d+)?`;
		const currentBasePath = stripMarkdownExtension(currentPath);
		const collisionMatch = currentBasePath.match(
			new RegExp(`^(.*?)(?: (${managedSuffixPattern}))?$`),
		);
		const pathWithoutCollisionSuffix = collisionMatch?.[1];
		const suffix = collisionMatch?.[2] ?? "";
		if (!pathWithoutCollisionSuffix) {
			return null;
		}

		const templatePath = buildConversationFilePath(
			this.getSettings(),
			this.createPathSource(snapshot, titleMarker, capturedAt),
		);
		const templateBasePath = stripMarkdownExtension(templatePath);
		const markerIndex = templateBasePath.indexOf(titleMarker);
		if (markerIndex === -1) {
			return null;
		}

		const prefix = templateBasePath.slice(0, markerIndex);
		const suffixTemplate = templateBasePath.slice(markerIndex + titleMarker.length);
		if (
			!pathWithoutCollisionSuffix.startsWith(prefix) ||
			!pathWithoutCollisionSuffix.endsWith(suffixTemplate)
		) {
			return null;
		}

		const extractedTitle = pathWithoutCollisionSuffix
			.slice(prefix.length, pathWithoutCollisionSuffix.length - suffixTemplate.length)
			.trim();
		return extractedTitle ? suffix : null;
	}

	private createPathSource(
		snapshot: NormalizedSnapshot,
		title: string,
		capturedAt: number,
	): ConversationFilePathSource {
		return {
			capturedAt,
			conversationKey: snapshot.conversationKey,
			conversationTitle: title,
			pageTitle: snapshot.pageTitle,
			pageUrl: snapshot.pageUrl,
		};
	}
}
