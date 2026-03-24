import type ObsidianChatCapturePlugin from "../main";

export async function saveNowCommand(
	plugin: ObsidianChatCapturePlugin,
): Promise<void> {
	await plugin.saveSnapshotNow();
}
