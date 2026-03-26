import { normalizePath } from "obsidian";
import { resolveSaveFolderForUrl } from "../settings/chat-targets";
import type { NormalizedSessionSnapshot, PluginSettings } from "../types";
import { formatLocalDate } from "./date-format";

export type RecordFilePathSource = Pick<
	NormalizedSessionSnapshot,
	"capturedAt" | "sessionKey" | "sessionTitle" | "pageTitle" | "pageUrl"
>;

export function sanitizeFileSegment(value: string): string {
	const sanitized = value
		.replace(/[\\/:*?"<>|#%&{}$!'@+=`]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return sanitized || "Untitled session";
}

export function buildRecordFilePath(
	settings: PluginSettings,
	snapshot: RecordFilePathSource,
	suffix = "",
): string {
	const saveFolder = resolveSaveFolderForUrl(settings, snapshot.pageUrl);
	const date = formatLocalDate(snapshot.capturedAt);
	const shortKey = snapshot.sessionKey.slice(0, 8);
	const title = sanitizeFileSegment(
		snapshot.sessionTitle || snapshot.pageTitle || shortKey,
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
