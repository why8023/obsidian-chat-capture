import type ObarPlugin from "../main";

export async function bindCurrentViewerCommand(
	plugin: ObarPlugin,
): Promise<void> {
	await plugin.bindCurrentViewer();
}
