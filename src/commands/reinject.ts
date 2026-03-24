import type ObarPlugin from "../main";

export async function reinjectCommand(
	plugin: ObarPlugin,
): Promise<void> {
	await plugin.reinjectCaptureScript();
}
