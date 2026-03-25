import type ObarPlugin from "../main";

export async function openCurrentSessionRecordCommand(
	plugin: ObarPlugin,
): Promise<void> {
	await plugin.openCurrentSessionRecord();
}
