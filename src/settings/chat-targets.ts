import { normalizePath } from "obsidian";
import {
	DEFAULT_CHAT_TARGET_SAVE_FOLDER,
	DEFAULT_CHAT_TARGET_URL_PATTERN,
	LEGACY_DEFAULT_SAVE_FOLDER,
} from "../constants";
import type { ChatTargetRule, PluginSettings } from "../types";

function normalizeFolderValue(value: string): string {
	return normalizePath(value).replace(/^\/+|\/+$/g, "");
}

function normalizeUrlPattern(
	input: string | undefined,
	fallback: string,
): string {
	if (input === undefined) {
		return fallback;
	}

	return input.trim();
}

function normalizeFolder(
	input: string | undefined,
	fallback: string,
): string {
	if (input === undefined) {
		return fallback;
	}

	const candidate = input.trim().replace(/^\/+|\/+$/g, "");
	return candidate ? normalizeFolderValue(candidate) : "";
}

function normalizeLegacyFolder(input: string | undefined): string {
	if (input === undefined || input.trim() === "" || input.trim() === LEGACY_DEFAULT_SAVE_FOLDER) {
		return DEFAULT_CHAT_TARGET_SAVE_FOLDER;
	}

	return normalizeFolder(input, DEFAULT_CHAT_TARGET_SAVE_FOLDER);
}

function isValidUrlPattern(value: string): boolean {
	return /^https?:\/\//i.test(value.trim());
}

export function createDefaultChatTargetRule(): ChatTargetRule {
	return {
		urlPattern: DEFAULT_CHAT_TARGET_URL_PATTERN,
		saveFolder: DEFAULT_CHAT_TARGET_SAVE_FOLDER,
	};
}

export function normalizeChatTargetRule(
	rule: Partial<ChatTargetRule> | undefined,
	fallback = createDefaultChatTargetRule(),
): ChatTargetRule {
	return {
		urlPattern: normalizeUrlPattern(rule?.urlPattern, fallback.urlPattern),
		saveFolder: normalizeFolder(rule?.saveFolder, fallback.saveFolder),
	};
}

export function normalizeChatTargetRules(
	rules: readonly Partial<ChatTargetRule>[] | null | undefined,
): ChatTargetRule[] {
	if (!rules || rules.length === 0) {
		return [createDefaultChatTargetRule()];
	}

	return rules.map((rule) => normalizeChatTargetRule(rule));
}

export function migrateLegacyChatTargetRules(data: {
	chatTargets?: readonly Partial<ChatTargetRule>[] | null;
	chatgptUrl?: string;
	saveFolder?: string;
}): ChatTargetRule[] {
	if (data.chatTargets && data.chatTargets.length > 0) {
		return normalizeChatTargetRules(data.chatTargets);
	}

	return [
		{
			urlPattern: normalizeUrlPattern(
				data.chatgptUrl,
				DEFAULT_CHAT_TARGET_URL_PATTERN,
			),
			saveFolder: normalizeLegacyFolder(data.saveFolder),
		},
	];
}

export function isActiveChatTargetRule(rule: ChatTargetRule): boolean {
	return isValidUrlPattern(rule.urlPattern) && rule.saveFolder.trim().length > 0;
}

export function getActiveChatTargetRules(
	settings: Pick<PluginSettings, "chatTargets">,
): ChatTargetRule[] {
	return settings.chatTargets
		.map((rule) => normalizeChatTargetRule(rule))
		.filter(isActiveChatTargetRule);
}

export function getPrimaryChatTarget(
	settings: Pick<PluginSettings, "chatTargets">,
): ChatTargetRule | null {
	return getActiveChatTargetRules(settings)[0] ?? null;
}

export function matchChatTarget(
	url: string | null | undefined,
	settings: Pick<PluginSettings, "chatTargets">,
): ChatTargetRule | null {
	if (!url) {
		return null;
	}

	return (
		getActiveChatTargetRules(settings)
			.filter((rule) => url.startsWith(rule.urlPattern))
			.sort((left, right) => right.urlPattern.length - left.urlPattern.length)[0] ??
		null
	);
}

export function isConfiguredChatUrl(
	url: string | null | undefined,
	settings: Pick<PluginSettings, "chatTargets">,
): boolean {
	return matchChatTarget(url, settings) !== null;
}

export function resolveSaveFolderForUrl(
	settings: Pick<PluginSettings, "chatTargets">,
	url: string | null | undefined,
): string {
	return (
		matchChatTarget(url, settings)?.saveFolder ??
		getPrimaryChatTarget(settings)?.saveFolder ??
		DEFAULT_CHAT_TARGET_SAVE_FOLDER
	);
}

export function getTrackedSaveFolders(
	settings: Pick<PluginSettings, "chatTargets">,
): string[] {
	return [...new Set(getActiveChatTargetRules(settings).map((rule) => rule.saveFolder))];
}
