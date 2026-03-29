import { getLanguage } from "obsidian";

interface SettingText {
	name: string;
	description: string;
	placeholder?: string;
}

export interface SettingsTabCopy {
	sections: {
		general: string;
		output: string;
		postProcessing: string;
		capture: string;
		debug: string;
	};
	fields: {
		chatTargets: SettingText;
		fileNameTemplate: SettingText;
		messageHeadingSummaryLength: SettingText;
		openNoteAfterSave: SettingText;
		postProcessingEnabled: SettingText;
		postProcessingCommands: SettingText;
		postProcessingOpenNote: SettingText;
		pollIntervalMs: SettingText;
		settleRepeatCount: SettingText;
		settleTimeoutMs: SettingText;
		autoCapture: SettingText;
		saveRawSnapshot: SettingText;
		maxHtmlSnippetLength: SettingText;
		debugMode: SettingText;
	};
	chatTargetRule: {
		namePrefix: string;
		description: string;
		urlPlaceholder: string;
		saveFolderPlaceholder: string;
	};
	actions: {
		addChatTarget: string;
		removeChatTarget: string;
		addPostProcessingCommand: string;
		removePostProcessingCommand: string;
		moveCommandUp: string;
		moveCommandDown: string;
	};
	postProcessingList: {
		empty: string;
		missingName: string;
		missingDescription: string;
	};
	commandPicker: {
		placeholder: string;
		empty: string;
		chooseHint: string;
		dismissHint: string;
	};
}

const ENGLISH_COPY: SettingsTabCopy = {
	sections: {
		general: "General",
		output: "Output format",
		postProcessing: "Post-save processing",
		capture: "Automatic capture",
		debug: "Debug and diagnostics",
	},
	fields: {
		chatTargets: {
			name: "AI match rules",
			description:
				"Map each URL prefix to its own save folder. The longest matching prefix wins.",
		},
		fileNameTemplate: {
			name: "File name template",
			description: "Use {{date}}, {{title}}, and {{key}} placeholders.",
			placeholder: "{{date}}_{{title}}",
		},
		messageHeadingSummaryLength: {
			name: "Message heading summary length",
			description:
				"Maximum characters appended after USER / AI in each message heading.",
			placeholder: "40",
		},
		openNoteAfterSave: {
			name: "Open note after save",
			description:
				"After a note is created or updated, open it in a Markdown tab. This may switch the visible tab.",
		},
		postProcessingEnabled: {
			name: "Run post-processing commands",
			description:
				"After a note is updated, run Obsidian command IDs from this list in order.",
		},
		postProcessingCommands: {
			name: "Post-processing commands",
			description:
				"Choose commands from Obsidian's registered command list. They run from top to bottom.",
		},
		postProcessingOpenNote: {
			name: "Open generated note before running",
			description:
				"Recommended when commands operate on the active note or editor. This may switch the visible tab.",
		},
		pollIntervalMs: {
			name: "Poll interval",
			description: "Polling interval in milliseconds while auto capture is running.",
			placeholder: "1500",
		},
		settleRepeatCount: {
			name: "Settle repeat count",
			description:
				"Fallback repeat count when no AI completion actions are detected.",
			placeholder: "2",
		},
		settleTimeoutMs: {
			name: "Settle timeout",
			description:
				"Fallback wait in milliseconds when no AI completion actions are detected.",
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
	chatTargetRule: {
		namePrefix: "AI match rule",
		description: "Use one URL prefix and one vault folder for each supported chat site.",
		urlPlaceholder: "https://chatgpt.com/",
		saveFolderPlaceholder: "chatgpt",
	},
	actions: {
		addChatTarget: "Add rule",
		removeChatTarget: "Remove rule",
		addPostProcessingCommand: "Add command",
		removePostProcessingCommand: "Remove",
		moveCommandUp: "Up",
		moveCommandDown: "Down",
	},
	postProcessingList: {
		empty: "No post-processing commands selected.",
		missingName: "Missing command",
		missingDescription: "This command is not currently available in Obsidian.",
	},
	commandPicker: {
		placeholder: "Search commands",
		empty: "No available commands found.",
		chooseHint: "Choose command",
		dismissHint: "Close",
	},
};

const CHINESE_COPY: SettingsTabCopy = {
	sections: {
		general: "常规",
		output: "导出格式",
		postProcessing: "保存后处理",
		capture: "自动采集",
		debug: "调试与诊断",
	},
	fields: {
		chatTargets: {
			name: "AI匹配规则",
			description: "为每个网址前缀单独配置保存目录。匹配时会优先使用更长的前缀。",
		},
		fileNameTemplate: {
			name: "文件名模板",
			description: "支持 {{date}}、{{title}} 和 {{key}} 占位符。",
			placeholder: "{{date}}_{{title}}",
		},
		messageHeadingSummaryLength: {
			name: "消息标题摘要长度",
			description: "每条消息标题里追加在 USER / AI 后面的摘要最大字符数。",
			placeholder: "40",
		},
		openNoteAfterSave: {
			name: "保存后自动打开笔记",
			description:
				"创建或更新笔记后，自动在 Markdown 标签页中打开。开启后可能会切换到该标签页。",
		},
		postProcessingEnabled: {
			name: "保存后执行命令",
			description: "笔记内容更新后，按顺序执行下面配置的 Obsidian 命令 ID。",
		},
		postProcessingCommands: {
			name: "后处理命令",
			description:
				"从 Obsidian 已注册的命令列表里选择。执行时会按从上到下的顺序运行。",
		},
		postProcessingOpenNote: {
			name: "执行前打开生成的笔记",
			description:
				"如果命令依赖当前活动笔记或编辑器，建议开启。开启后可能会切换到该标签页。",
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
	chatTargetRule: {
		namePrefix: "AI匹配规则",
		description: "每条规则对应一个聊天网址前缀和一个库内保存目录。",
		urlPlaceholder: "https://chatgpt.com/",
		saveFolderPlaceholder: "chatgpt",
	},
	actions: {
		addChatTarget: "新增规则",
		removeChatTarget: "删除规则",
		addPostProcessingCommand: "添加命令",
		removePostProcessingCommand: "删除",
		moveCommandUp: "上移",
		moveCommandDown: "下移",
	},
	postProcessingList: {
		empty: "当前还没有选择任何后处理命令。",
		missingName: "命令不可用",
		missingDescription: "这个命令当前没有在 Obsidian 中注册。",
	},
	commandPicker: {
		placeholder: "搜索命令",
		empty: "没有可选命令。",
		chooseHint: "选择命令",
		dismissHint: "关闭",
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
