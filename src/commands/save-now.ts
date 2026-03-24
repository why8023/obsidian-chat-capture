import type ObarPlugin from "../main";

export async function saveNowCommand(
	plugin: ObarPlugin,
): Promise<void> {
	await plugin.saveSnapshotNow();
}
