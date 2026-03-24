import { normalizePath } from "obsidian";
import { resolveSaveFolderForUrl } from "../settings/chat-targets";
import type { NormalizedSnapshot, PluginSettings } from "../types";

export function sanitizeFileSegment(value: string): string {
	const sanitized = value
		.replace(/[\\/:*?"<>|#%&{}$!'@+=`]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return sanitized || "Untitled conversation";
}

export function buildConversationFilePath(
	settings: PluginSettings,
	snapshot: NormalizedSnapshot,
	suffix = "",
): string {
	const saveFolder = resolveSaveFolderForUrl(settings, snapshot.pageUrl);
	const date = new Date(snapshot.capturedAt).toISOString().slice(0, 10);
	const shortKey = snapshot.conversationKey.slice(0, 8);
	const title = sanitizeFileSegment(
		snapshot.conversationTitle || snapshot.pageTitle || shortKey,
	).slice(0, 80);

	const base = settings.fileNameTemplate
		.split("{{date}}")
		.join(date)
		.split("{{title}}")
		.join(title)
		.split("{{key}}")
		.join(shortKey);
	const fileName = sanitizeFileSegment(`${base}${suffix ? ` ${suffix}` : ""}`);

	return normalizePath(`${saveFolder}/${fileName}.md`);
}
