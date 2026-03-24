import { App, PluginSettingTab, Setting } from "obsidian";
import type ObarPlugin from "../main";
import type { ChatTargetRule } from "../types";
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
		this.addChatTargetSettings(copy);
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

	private addChatTargetSettings(copy: SettingsTabCopy): void {
		new Setting(this.containerEl)
			.setName(copy.fields.chatTargets.name)
			.setDesc(copy.fields.chatTargets.description)
			.addButton((button) =>
				button
					.setButtonText(copy.actions.addChatTarget)
					.onClick(async () => {
						await this.plugin.updateSettings({
							chatTargets: [
								...this.plugin.settings.chatTargets,
								{
									urlPattern: "",
									saveFolder: "",
								},
							],
						});
						this.display();
					}),
			);

		this.plugin.settings.chatTargets.forEach((rule, index) => {
			const setting = new Setting(this.containerEl)
				.setName(`${copy.chatTargetRule.namePrefix} ${index + 1}`)
				.setDesc(copy.chatTargetRule.description)
				.addText((text) => {
					text.inputEl.addClass("obar-chat-target-url-input");
					text.setPlaceholder(copy.chatTargetRule.urlPlaceholder);
					return text
						.setValue(rule.urlPattern)
						.onChange(async (value) => this.updateChatTarget(index, { urlPattern: value }));
				})
				.addText((text) => {
					text.inputEl.addClass("obar-chat-target-folder-input");
					text.setPlaceholder(copy.chatTargetRule.saveFolderPlaceholder);
					return text
						.setValue(rule.saveFolder)
						.onChange(async (value) => this.updateChatTarget(index, { saveFolder: value }));
				});

			if (this.plugin.settings.chatTargets.length > 1) {
				setting.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip(copy.actions.removeChatTarget)
						.onClick(async () => {
							await this.plugin.updateSettings({
								chatTargets: this.plugin.settings.chatTargets.filter(
									(_, candidateIndex) => candidateIndex !== index,
								),
							});
							this.display();
						}),
				);
			}
		});
	}

	private async updateChatTarget(
		index: number,
		patch: Partial<ChatTargetRule>,
	): Promise<void> {
		await this.plugin.updateSettings({
			chatTargets: this.plugin.settings.chatTargets.map((rule, candidateIndex) =>
				candidateIndex === index ? { ...rule, ...patch } : rule,
			),
		});
	}
}
