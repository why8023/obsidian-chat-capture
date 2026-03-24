import type { PluginSettings, PluginStateData } from "./types";

export const EXTRACTOR_VERSION = "0.1.0";
export const PLUGIN_STATE_VERSION = "1";
export const LOG_BUFFER_LIMIT = 500;

export const CHATGPT_URL_PREFIXES = [
	"https://chatgpt.com/",
	"https://chat.openai.com/",
];

export const DEFAULT_SETTINGS: PluginSettings = {
	chatgptUrl: "https://chatgpt.com/",
	saveFolder: "ChatGPT Chats",
	fileNameTemplate: "{{date}} {{title}}",
	pollIntervalMs: 1500,
	settleRepeatCount: 2,
	settleTimeoutMs: 3000,
	autoCapture: true,
	saveRawSnapshot: false,
	maxHtmlSnippetLength: 1200,
	debugMode: false,
};

export const DEFAULT_PLUGIN_STATE: PluginStateData = {
	version: PLUGIN_STATE_VERSION,
	sessions: {},
	capturePaused: false,
};
