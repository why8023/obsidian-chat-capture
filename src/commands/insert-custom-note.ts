import type { Editor } from "obsidian";
import { renderCustomNoteBlock } from "../persistence/custom-note-blocks";

export function insertCustomNoteCommand(editor: Editor): void {
	const selection = editor.getSelection();
	const insertionStart = editor.getCursor("from");

	editor.replaceSelection(renderCustomNoteBlock(selection));

	if (selection.length === 0) {
		editor.setCursor({
			line: insertionStart.line + 1,
			ch: 0,
		});
	}
}
