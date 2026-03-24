import type { PluginSettings, PluginStateData } from "./types";

export const EXTRACTOR_VERSION = "0.3.0";
export const LOG_BUFFER_LIMIT = 500;
export const OBAR_CAPTURE_SOURCE = "obar-chatgpt-webviewer";

export const CHATGPT_URL_PREFIXES = ["https://chatgpt.com/"];

export const DEFAULT_SETTINGS: PluginSettings = {
	chatgptUrl: "https://chatgpt.com/",
	saveFolder: "OBAR Chats",
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
	capturePaused: false,
};
