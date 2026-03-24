import type ObsidianChatCapturePlugin from "../main";

export async function openChatGPTCommand(
	plugin: ObsidianChatCapturePlugin,
): Promise<void> {
	await plugin.openChatGPTViewer();
}
