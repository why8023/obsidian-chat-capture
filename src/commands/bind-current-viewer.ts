import type ObsidianChatCapturePlugin from "../main";

export async function bindCurrentViewerCommand(
	plugin: ObsidianChatCapturePlugin,
): Promise<void> {
	await plugin.bindCurrentViewer();
}
