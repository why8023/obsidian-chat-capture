import { normalizePath } from "obsidian";
import { DEFAULT_PLUGIN_STATE, DEFAULT_SETTINGS } from "../constants";
import type {
	PersistedPluginData,
	PluginSettings,
	PluginStateData,
} from "../types";

function clampInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}

	const rounded = Math.round(value);
	return Math.max(minimum, Math.min(maximum, rounded));
}

function normalizeFolder(input: string | undefined, fallback: string): string {
	const candidate = (input ?? fallback).trim().replace(/^\/+|\/+$/g, "");
	const normalized = normalizePath(candidate || fallback).replace(/^\/+|\/+$/g, "");
	return normalized || fallback;
}

function normalizeTemplate(input: string | undefined, fallback: string): string {
	const template = (input ?? fallback).trim();
	return template || fallback;
}

function normalizeConversationRoundSeparator(
	input: string | undefined,
	fallback: string,
): string {
	if (input === undefined) {
		return fallback;
	}

	return input.trim();
}

function normalizeUrl(input: string | undefined, fallback: string): string {
	const value = (input ?? fallback).trim();
	if (!value.startsWith("http://") && !value.startsWith("https://")) {
		return fallback;
	}

	return value;
}

export function normalizePluginSettings(
	data?: Partial<PluginSettings>,
): PluginSettings {
	return {
		chatgptUrl: normalizeUrl(data?.chatgptUrl, DEFAULT_SETTINGS.chatgptUrl),
		saveFolder: normalizeFolder(data?.saveFolder, DEFAULT_SETTINGS.saveFolder),
		fileNameTemplate: normalizeTemplate(
			data?.fileNameTemplate,
			DEFAULT_SETTINGS.fileNameTemplate,
		),
		conversationRoundSeparator: normalizeConversationRoundSeparator(
			data?.conversationRoundSeparator,
			DEFAULT_SETTINGS.conversationRoundSeparator,
		),
		pollIntervalMs: clampInteger(
			data?.pollIntervalMs,
			DEFAULT_SETTINGS.pollIntervalMs,
			500,
			60_000,
		),
		settleRepeatCount: clampInteger(
			data?.settleRepeatCount,
			DEFAULT_SETTINGS.settleRepeatCount,
			1,
			10,
		),
		settleTimeoutMs: clampInteger(
			data?.settleTimeoutMs,
			DEFAULT_SETTINGS.settleTimeoutMs,
			500,
			60_000,
		),
		autoCapture: data?.autoCapture ?? DEFAULT_SETTINGS.autoCapture,
		saveRawSnapshot: data?.saveRawSnapshot ?? DEFAULT_SETTINGS.saveRawSnapshot,
		maxHtmlSnippetLength: clampInteger(
			data?.maxHtmlSnippetLength,
			DEFAULT_SETTINGS.maxHtmlSnippetLength,
			200,
			20_000,
		),
		debugMode: data?.debugMode ?? DEFAULT_SETTINGS.debugMode,
	};
}

export function normalizePluginState(
	data?: Partial<PluginStateData>,
): PluginStateData {
	return {
		capturePaused: data?.capturePaused ?? DEFAULT_PLUGIN_STATE.capturePaused,
	};
}

export function normalizePersistedData(
	data: PersistedPluginData | null | undefined,
): { settings: PluginSettings; state: PluginStateData } {
	return {
		settings: normalizePluginSettings(data?.settings),
		state: normalizePluginState(data?.state),
	};
}
