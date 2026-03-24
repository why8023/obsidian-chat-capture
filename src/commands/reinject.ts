import type ObsidianChatCapturePlugin from "../main";

export async function reinjectCommand(
	plugin: ObsidianChatCapturePlugin,
): Promise<void> {
	await plugin.reinjectCaptureScript();
}
