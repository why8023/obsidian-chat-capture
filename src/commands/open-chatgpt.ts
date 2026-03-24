import type ObarPlugin from "../main";

export async function openChatGPTCommand(
	plugin: ObarPlugin,
): Promise<void> {
	await plugin.openChatGPTViewer();
}
