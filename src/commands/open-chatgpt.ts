import type ObarPlugin from "../main";

export async function openConfiguredChatViewerCommand(
	plugin: ObarPlugin,
): Promise<void> {
	await plugin.openConfiguredChatViewer();
}
