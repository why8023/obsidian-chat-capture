import { Notice } from "obsidian";
import type ObarPlugin from "../main";
import { bindCurrentViewerCommand } from "./bind-current-viewer";
import { openChatGPTCommand } from "./open-chatgpt";
import { reinjectCommand } from "./reinject";
import { saveNowCommand } from "./save-now";

export function registerCommands(plugin: ObarPlugin): void {
	plugin.addCommand({
		id: "obar-open-chatgpt-in-web-viewer",
		name: "Open web viewer",
		callback: () => {
			void openChatGPTCommand(plugin);
		},
	});

	plugin.addCommand({
		id: "obar-bind-current-chatgpt-web-viewer",
		name: "Bind current web viewer",
		callback: () => {
			void bindCurrentViewerCommand(plugin);
		},
	});

	plugin.addCommand({
		id: "obar-reinject-capture-script",
		name: "Reinject OBAR capture script",
		callback: () => {
			void reinjectCommand(plugin);
		},
	});

	plugin.addCommand({
		id: "obar-save-current-snapshot-now",
		name: "Save current snapshot now",
		callback: () => {
			void saveNowCommand(plugin);
		},
	});

	plugin.addCommand({
		id: "obar-pause-auto-capture",
		name: "Pause auto capture",
		callback: () => {
			void plugin.pauseAutoCapture();
		},
	});

	plugin.addCommand({
		id: "obar-resume-auto-capture",
		name: "Resume auto capture",
		callback: () => {
			void plugin.resumeAutoCapture();
		},
	});

	plugin.addCommand({
		id: "obar-open-log",
		name: "Open OBAR log",
		callback: () => {
			if (plugin.logger.getEntries().length === 0) {
				new Notice("There are no OBAR logs yet.");
			}
			plugin.openObarLog();
		},
	});

	plugin.addCommand({
		id: "obar-migrate-legacy-properties",
		name: "Migrate legacy properties to OBAR",
		callback: () => {
			void plugin.migrateLegacyConversationProperties();
		},
	});
}
