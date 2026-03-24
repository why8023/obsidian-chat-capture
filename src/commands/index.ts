import { Notice } from "obsidian";
import type ObsidianChatCapturePlugin from "../main";
import { bindCurrentViewerCommand } from "./bind-current-viewer";
import { openChatGPTCommand } from "./open-chatgpt";
import { reinjectCommand } from "./reinject";
import { saveNowCommand } from "./save-now";

export function registerCommands(plugin: ObsidianChatCapturePlugin): void {
	plugin.addCommand({
		id: "open-chatgpt-in-web-viewer",
		name: "Open web viewer",
		callback: () => {
			void openChatGPTCommand(plugin);
		},
	});

	plugin.addCommand({
		id: "bind-current-chatgpt-web-viewer",
		name: "Bind current web viewer",
		callback: () => {
			void bindCurrentViewerCommand(plugin);
		},
	});

	plugin.addCommand({
		id: "reinject-capture-script",
		name: "Reinject capture script",
		callback: () => {
			void reinjectCommand(plugin);
		},
	});

	plugin.addCommand({
		id: "save-current-snapshot-now",
		name: "Save current snapshot now",
		callback: () => {
			void saveNowCommand(plugin);
		},
	});

	plugin.addCommand({
		id: "pause-auto-capture",
		name: "Pause auto capture",
		callback: () => {
			void plugin.pauseAutoCapture();
		},
	});

	plugin.addCommand({
		id: "resume-auto-capture",
		name: "Resume auto capture",
		callback: () => {
			void plugin.resumeAutoCapture();
		},
	});

	plugin.addCommand({
		id: "open-capture-log",
		name: "Open capture log",
		callback: () => {
			if (plugin.logger.getEntries().length === 0) {
				new Notice("There are no capture logs yet.");
			}
			plugin.openCaptureLog();
		},
	});
}
