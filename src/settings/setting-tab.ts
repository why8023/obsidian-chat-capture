import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidianChatCapturePlugin from "../main";

export class ChatCaptureSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ObsidianChatCapturePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Chat URL")
			.setDesc("Open this URL in the controlled web viewer.")
			.addText((text) =>
				text
					.setPlaceholder("https://chatgpt.com/")
					.setValue(this.plugin.settings.chatgptUrl)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ chatgptUrl: value });
					}),
			);

		new Setting(containerEl)
			.setName("Save folder")
			.setDesc("Folder inside the vault where conversation notes are written.")
			.addText((text) =>
				text
					.setPlaceholder("Chat captures")
					.setValue(this.plugin.settings.saveFolder)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ saveFolder: value });
					}),
			);

		new Setting(containerEl)
			.setName("File name template")
			.setDesc("Use {{date}}, {{title}}, and {{key}} placeholders.")
			.addText((text) =>
				text
					.setPlaceholder("{{date}} {{title}}")
					.setValue(this.plugin.settings.fileNameTemplate)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ fileNameTemplate: value });
					}),
			);

		new Setting(containerEl)
			.setName("Poll interval")
			.setDesc("Polling interval in milliseconds while auto capture is running.")
			.addText((text) =>
				text
					.setPlaceholder("1500")
					.setValue(String(this.plugin.settings.pollIntervalMs))
					.onChange(async (value) => {
						await this.plugin.updateSettings({
							pollIntervalMs: Number.parseInt(value, 10),
						});
					}),
			);

		new Setting(containerEl)
			.setName("Settle repeat count")
			.setDesc("Fallback repeat count when no assistant completion actions are detected.")
			.addText((text) =>
				text
					.setPlaceholder("2")
					.setValue(String(this.plugin.settings.settleRepeatCount))
					.onChange(async (value) => {
						await this.plugin.updateSettings({
							settleRepeatCount: Number.parseInt(value, 10),
						});
					}),
			);

		new Setting(containerEl)
			.setName("Settle timeout")
			.setDesc("Fallback wait in milliseconds when no assistant completion actions are detected.")
			.addText((text) =>
				text
					.setPlaceholder("3000")
					.setValue(String(this.plugin.settings.settleTimeoutMs))
					.onChange(async (value) => {
						await this.plugin.updateSettings({
							settleTimeoutMs: Number.parseInt(value, 10),
						});
					}),
			);

		new Setting(containerEl)
			.setName("Auto capture")
			.setDesc("Keep polling the controlled web viewer in the background.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoCapture)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ autoCapture: value });
					}),
			);

		new Setting(containerEl)
			.setName("Save raw snapshots")
			.setDesc("Write the latest raw and normalized snapshots to the plugin debug folder.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.saveRawSnapshot)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ saveRawSnapshot: value });
					}),
			);

		new Setting(containerEl)
			.setName("HTML snippet limit")
			.setDesc("Maximum raw HTML snippet length preserved per captured message.")
			.addText((text) =>
				text
					.setPlaceholder("1200")
					.setValue(String(this.plugin.settings.maxHtmlSnippetLength))
					.onChange(async (value) => {
						await this.plugin.updateSettings({
							maxHtmlSnippetLength: Number.parseInt(value, 10),
						});
					}),
			);

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc("Keep verbose logs and snapshot dumps for troubleshooting.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugMode)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ debugMode: value });
					}),
			);
	}
}
