import type { PluginSettings, PluginStateData } from "./types";

export const EXTRACTOR_VERSION = "0.3.0";
export const LOG_BUFFER_LIMIT = 500;
export const OBAR_CAPTURE_SOURCE = "obar-chatgpt-webviewer";
export const OBAR_UI_PREFIX = "OBAR";

export const DEFAULT_CHAT_TARGET_URL_PATTERN = "https://chatgpt.com/";
export const DEFAULT_CHAT_TARGET_SAVE_FOLDER = "chatgpt";

export const DEFAULT_SETTINGS: PluginSettings = {
	chatTargets: [
		{
			urlPattern: DEFAULT_CHAT_TARGET_URL_PATTERN,
			saveFolder: DEFAULT_CHAT_TARGET_SAVE_FOLDER,
		},
	],
	fileNameTemplate: "{{date}}_{{title}}",
	sessionRoundSeparator: "---",
	messageHeadingSummaryLength: 40,
	postProcessing: {
		enabled: false,
		commandIds: [],
		openNote: true,
	},
	openNoteAfterSave: false,
	pollIntervalMs: 1500,
	settleRepeatCount: 2,
	settleTimeoutMs: 3000,
	autoCapture: true,
	saveRawSnapshot: false,
	maxHtmlSnippetLength: 1200,
	debugMode: false,
};

export const DEFAULT_PLUGIN_STATE: PluginStateData = {
	capturePaused: false,
};

export function formatObarUiText(message: string): string {
	return `${OBAR_UI_PREFIX}: ${message}`;
}
