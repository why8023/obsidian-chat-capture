import type ObarPlugin from "../main";
import { insertCustomNoteCommand } from "./insert-custom-note";

export function registerCommands(plugin: ObarPlugin): void {
	plugin.addCommand({
		id: "open-configured-chat-web-viewer",
		name: "Open configured chat web viewer",
		callback: () => {
			void plugin.openConfiguredChatViewer();
		},
	});

	plugin.addCommand({
		id: "bind-current-chat-web-viewer",
		name: "Bind current chat web viewer",
		callback: () => {
			void plugin.bindCurrentViewer();
		},
	});

	plugin.addCommand({
		id: "save-current-session",
		name: "Save current session",
		callback: () => {
			void plugin.saveSnapshotNow();
		},
	});

	plugin.addCommand({
		id: "open-current-session-record",
		name: "Open current session record",
		callback: () => {
			void plugin.openCurrentSessionRecord();
		},
	});

	plugin.addCommand({
		id: "insert-custom-note",
		name: "Insert custom note",
		editorCallback: (editor) => {
			insertCustomNoteCommand(editor);
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
}
