import { getLanguage } from "obsidian";

interface SettingText {
	name: string;
	description: string;
	placeholder?: string;
}

export interface SettingsTabCopy {
	sections: {
		general: string;
		capture: string;
		debug: string;
	};
	fields: {
		chatUrl: SettingText;
		saveFolder: SettingText;
		fileNameTemplate: SettingText;
		pollIntervalMs: SettingText;
		settleRepeatCount: SettingText;
		settleTimeoutMs: SettingText;
		autoCapture: SettingText;
		saveRawSnapshot: SettingText;
		maxHtmlSnippetLength: SettingText;
		debugMode: SettingText;
	};
}

const ENGLISH_COPY: SettingsTabCopy = {
	sections: {
		general: "General",
		capture: "Automatic capture",
		debug: "Debug and diagnostics",
	},
	fields: {
		chatUrl: {
			name: "Chat URL",
			description: "Open this URL in the controlled web viewer.",
			placeholder: "https://chatgpt.com/",
		},
		saveFolder: {
			name: "Save folder",
			description: "Folder inside the vault where conversation notes are written.",
			placeholder: "OBAR Chats",
		},
		fileNameTemplate: {
			name: "File name template",
			description: "Use {{date}}, {{title}}, and {{key}} placeholders.",
			placeholder: "{{date}} {{title}}",
		},
		pollIntervalMs: {
			name: "Poll interval",
			description: "Polling interval in milliseconds while auto capture is running.",
			placeholder: "1500",
		},
		settleRepeatCount: {
			name: "Settle repeat count",
			description:
				"Fallback repeat count when no assistant completion actions are detected.",
			placeholder: "2",
		},
		settleTimeoutMs: {
			name: "Settle timeout",
			description:
				"Fallback wait in milliseconds when no assistant completion actions are detected.",
			placeholder: "3000",
		},
		autoCapture: {
			name: "Auto capture",
			description: "Keep polling the controlled web viewer in the background.",
		},
		saveRawSnapshot: {
			name: "Save raw snapshots",
			description:
				"Write the latest raw and normalized snapshots to the plugin debug folder.",
		},
		maxHtmlSnippetLength: {
			name: "HTML snippet limit",
			description: "Maximum raw HTML snippet length preserved per captured message.",
			placeholder: "1200",
		},
		debugMode: {
			name: "Debug mode",
			description: "Keep verbose logs and snapshot dumps for troubleshooting.",
		},
	},
};

const CHINESE_COPY: SettingsTabCopy = {
	sections: {
		general: "常规",
		capture: "自动采集",
		debug: "调试与诊断",
	},
	fields: {
		chatUrl: {
			name: "聊天地址",
			description: "在受控的 Web Viewer 中打开这个地址。",
			placeholder: "https://chatgpt.com/",
		},
		saveFolder: {
			name: "保存目录",
			description: "会话笔记写入到库内的这个目录。",
			placeholder: "OBAR Chats",
		},
		fileNameTemplate: {
			name: "文件名模板",
			description: "支持 {{date}}、{{title}} 和 {{key}} 占位符。",
			placeholder: "{{date}} {{title}}",
		},
		pollIntervalMs: {
			name: "轮询间隔",
			description: "自动采集运行时的轮询间隔，单位毫秒。",
			placeholder: "1500",
		},
		settleRepeatCount: {
			name: "稳定重复次数",
			description: "当检测不到回复完成动作时，回退到文本判稳所需的重复次数。",
			placeholder: "2",
		},
		settleTimeoutMs: {
			name: "稳定超时",
			description: "当检测不到回复完成动作时，回退等待的时长，单位毫秒。",
			placeholder: "3000",
		},
		autoCapture: {
			name: "自动采集",
			description: "在后台持续轮询当前受控的 Web Viewer。",
		},
		saveRawSnapshot: {
			name: "保存原始快照",
			description: "将最新的原始快照和归一化快照写入插件调试目录。",
		},
		maxHtmlSnippetLength: {
			name: "HTML 片段长度上限",
			description: "每条消息保留的原始 HTML 调试片段最大长度。",
			placeholder: "1200",
		},
		debugMode: {
			name: "调试模式",
			description: "保留更详细的日志和快照转储，便于排查问题。",
		},
	},
};

function readCurrentLanguage(): string {
	try {
		if (typeof getLanguage === "function") {
			const current = getLanguage().trim();
			if (current) {
				return current;
			}
		}
	} catch {
		// Older Obsidian versions may not expose getLanguage().
	}

	if (typeof window !== "undefined") {
		const stored = window.localStorage.getItem("language")?.trim();
		if (stored) {
			return stored;
		}

		const navigatorLanguage = window.navigator?.language?.trim();
		if (navigatorLanguage) {
			return navigatorLanguage;
		}
	}

	if (typeof document !== "undefined") {
		const documentLanguage = document.documentElement?.lang?.trim();
		if (documentLanguage) {
			return documentLanguage;
		}
	}

	return "en";
}

export function getSettingsTabCopy(): SettingsTabCopy {
	return readCurrentLanguage().toLowerCase().startsWith("zh")
		? CHINESE_COPY
		: ENGLISH_COPY;
}
