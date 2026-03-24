import { App, PluginSettingTab, Setting } from "obsidian";
import type ObarPlugin from "../main";
import { getSettingsTabCopy, type SettingsTabCopy } from "./localization";

export class ObarSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ObarPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const copy = getSettingsTabCopy();
		containerEl.empty();

		this.addSectionHeading(copy.sections.general);
		this.addTextSetting(copy.fields.chatUrl, this.plugin.settings.chatgptUrl, async (value) => {
			await this.plugin.updateSettings({ chatgptUrl: value });
		});
		this.addTextSetting(
			copy.fields.saveFolder,
			this.plugin.settings.saveFolder,
			async (value) => {
				await this.plugin.updateSettings({ saveFolder: value });
			},
		);
		this.addTextSetting(
			copy.fields.fileNameTemplate,
			this.plugin.settings.fileNameTemplate,
			async (value) => {
				await this.plugin.updateSettings({ fileNameTemplate: value });
			},
		);

		this.addSectionHeading(copy.sections.output);
		this.addTextSetting(
			copy.fields.conversationRoundSeparator,
			this.plugin.settings.conversationRoundSeparator,
			async (value) => {
				await this.plugin.updateSettings({ conversationRoundSeparator: value });
			},
		);

		this.addSectionHeading(copy.sections.capture);
		this.addToggleSetting(
			copy.fields.autoCapture,
			this.plugin.settings.autoCapture,
			async (value) => {
				await this.plugin.updateSettings({ autoCapture: value });
			},
		);
		this.addTextSetting(
			copy.fields.pollIntervalMs,
			String(this.plugin.settings.pollIntervalMs),
			async (value) => {
				await this.plugin.updateSettings({
					pollIntervalMs: Number.parseInt(value, 10),
				});
			},
		);
		this.addTextSetting(
			copy.fields.settleRepeatCount,
			String(this.plugin.settings.settleRepeatCount),
			async (value) => {
				await this.plugin.updateSettings({
					settleRepeatCount: Number.parseInt(value, 10),
				});
			},
		);
		this.addTextSetting(
			copy.fields.settleTimeoutMs,
			String(this.plugin.settings.settleTimeoutMs),
			async (value) => {
				await this.plugin.updateSettings({
					settleTimeoutMs: Number.parseInt(value, 10),
				});
			},
		);

		this.addSectionHeading(copy.sections.debug);
		this.addToggleSetting(
			copy.fields.saveRawSnapshot,
			this.plugin.settings.saveRawSnapshot,
			async (value) => {
				await this.plugin.updateSettings({ saveRawSnapshot: value });
			},
		);
		this.addTextSetting(
			copy.fields.maxHtmlSnippetLength,
			String(this.plugin.settings.maxHtmlSnippetLength),
			async (value) => {
				await this.plugin.updateSettings({
					maxHtmlSnippetLength: Number.parseInt(value, 10),
				});
			},
		);
		this.addToggleSetting(
			copy.fields.debugMode,
			this.plugin.settings.debugMode,
			async (value) => {
				await this.plugin.updateSettings({ debugMode: value });
			},
		);
	}

	private addSectionHeading(title: string): void {
		new Setting(this.containerEl).setName(title).setHeading();
	}

	private addTextSetting(
		copy: SettingsTabCopy["fields"][keyof SettingsTabCopy["fields"]],
		value: string,
		onChange: (value: string) => Promise<void>,
	): void {
		new Setting(this.containerEl)
			.setName(copy.name)
			.setDesc(copy.description)
			.addText((text) => {
				if (copy.placeholder) {
					text.setPlaceholder(copy.placeholder);
				}

				return text.setValue(value).onChange(onChange);
			});
	}

	private addToggleSetting(
		copy: SettingsTabCopy["fields"][keyof SettingsTabCopy["fields"]],
		value: boolean,
		onChange: (value: boolean) => Promise<void>,
	): void {
		new Setting(this.containerEl)
			.setName(copy.name)
			.setDesc(copy.description)
			.addToggle((toggle) => toggle.setValue(value).onChange(onChange));
	}
}
