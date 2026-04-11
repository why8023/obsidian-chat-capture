import { App, PluginSettingTab, Setting } from "obsidian";
import { getObsidianCommand } from "../commands/command-registry";
import type ObarPlugin from "../main";
import type { ChatTargetRule } from "../types";
import { CommandPickerModal } from "./command-picker-modal";
import { getSettingsTabCopy, type SettingsTabCopy } from "./localization";

type SettingsPageTabId = "general" | "output" | "capture" | "debug";

interface SettingsPageTabDefinition {
	id: SettingsPageTabId;
	label: string;
	description: string;
}

export class ObarSettingTab extends PluginSettingTab {
	private activeTab: SettingsPageTabId = "general";

	constructor(app: App, private readonly plugin: ObarPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const copy = getSettingsTabCopy();
		containerEl.empty();

		const contentEl = this.renderSettingsPageChrome(containerEl, copy);
		this.renderActiveTab(contentEl, copy);
	}

	private getSettingsPageTabs(copy: SettingsTabCopy): readonly SettingsPageTabDefinition[] {
		return [
			{
				id: "general",
				label: copy.tabs.general.label,
				description: copy.tabs.general.description,
			},
			{
				id: "output",
				label: copy.tabs.output.label,
				description: copy.tabs.output.description,
			},
			{
				id: "capture",
				label: copy.tabs.capture.label,
				description: copy.tabs.capture.description,
			},
			{
				id: "debug",
				label: copy.tabs.debug.label,
				description: copy.tabs.debug.description,
			},
		];
	}

	private renderSettingsPageChrome(
		containerEl: HTMLElement,
		copy: SettingsTabCopy,
	): HTMLDivElement {
		containerEl.classList.add("obar-settings-root");

		const tabs = this.getSettingsPageTabs(copy);
		const activeTab = tabs.find((tab) => tab.id === this.activeTab) ?? tabs[0]!;
		this.activeTab = activeTab.id;

		const pageEl = containerEl.createDiv({ cls: "obar-settings-page" });
		const heroEl = pageEl.createDiv({ cls: "obar-settings-hero" });
		const titleSetting = new Setting(heroEl).setName(copy.page.title).setHeading();
		titleSetting.settingEl.classList.add("obar-settings-page-heading");
		titleSetting.settingEl
			.querySelector<HTMLElement>(".setting-item-name")
			?.classList.add("obar-settings-page-title");
		heroEl.createEl("p", {
			cls: "obar-settings-page-description",
			text: copy.page.description,
		});

		const tabsEl = pageEl.createDiv({ cls: "obar-settings-tabs-nav" });
		tabsEl.setAttribute("role", "tablist");

		tabs.forEach((tab) => {
			const buttonEl = tabsEl.createEl("button", {
				cls: "obar-settings-tab-button",
				text: tab.label,
			});
			buttonEl.type = "button";
			buttonEl.setAttribute("role", "tab");
			buttonEl.setAttribute("aria-selected", String(tab.id === activeTab.id));

			if (tab.id === activeTab.id) {
				buttonEl.classList.add("is-active");
			}

			buttonEl.addEventListener("click", () => {
				if (this.activeTab === tab.id) {
					return;
				}

				this.activeTab = tab.id;
				this.display();
			});
		});

		pageEl.createEl("p", {
			cls: "obar-settings-tab-description",
			text: activeTab.description,
		});

		return pageEl.createDiv({ cls: "obar-settings-tab-content" });
	}

	private renderSettingsPanel(
		containerEl: HTMLElement,
		renderContent: (panelBodyEl: HTMLDivElement) => void,
	): void {
		const panelEl = containerEl.createDiv({ cls: "obar-settings-panel" });
		const panelBodyEl = panelEl.createDiv({ cls: "obar-settings-panel-body" });
		renderContent(panelBodyEl);
	}

	private renderActiveTab(containerEl: HTMLElement, copy: SettingsTabCopy): void {
		switch (this.activeTab) {
			case "general":
				this.renderSettingsPanel(containerEl, (panelBodyEl) => {
					this.renderGeneralSettingsSection(panelBodyEl, copy);
				});
				break;
			case "output":
				this.renderSettingsPanel(containerEl, (panelBodyEl) => {
					this.renderOutputSettingsSection(panelBodyEl, copy);
				});
				this.renderSettingsPanel(containerEl, (panelBodyEl) => {
					this.renderPostProcessingSettingsSection(panelBodyEl, copy);
				});
				break;
			case "capture":
				this.renderSettingsPanel(containerEl, (panelBodyEl) => {
					this.renderCaptureSettingsSection(panelBodyEl, copy);
				});
				break;
			case "debug":
				this.renderSettingsPanel(containerEl, (panelBodyEl) => {
					this.renderDebugSettingsSection(panelBodyEl, copy);
				});
				break;
		}
	}

	private renderGeneralSettingsSection(
		containerEl: HTMLElement,
		copy: SettingsTabCopy,
	): void {
		this.addSectionHeading(containerEl, copy.sections.general);
		this.addChatTargetSettings(containerEl, copy);
		this.addTextSetting(
			containerEl,
			copy.fields.fileNameTemplate,
			this.plugin.settings.fileNameTemplate,
			async (value) => {
				await this.plugin.updateSettings({ fileNameTemplate: value });
			},
		);
	}

	private renderOutputSettingsSection(
		containerEl: HTMLElement,
		copy: SettingsTabCopy,
	): void {
		this.addSectionHeading(containerEl, copy.sections.output);
		this.addTextSetting(
			containerEl,
			copy.fields.messageHeadingSummaryLength,
			String(this.plugin.settings.messageHeadingSummaryLength),
			async (value) => {
				await this.plugin.updateSettings({
					messageHeadingSummaryLength: Number.parseInt(value, 10),
				});
			},
		);
	}

	private renderPostProcessingSettingsSection(
		containerEl: HTMLElement,
		copy: SettingsTabCopy,
	): void {
		this.addSectionHeading(containerEl, copy.sections.postProcessing);
		this.addToggleSetting(
			containerEl,
			copy.fields.openNoteAfterSave,
			this.plugin.settings.openNoteAfterSave,
			async (value) => {
				await this.plugin.updateSettings({ openNoteAfterSave: value });
			},
		);
		this.addToggleSetting(
			containerEl,
			copy.fields.postProcessingEnabled,
			this.plugin.settings.postProcessing.enabled,
			async (value) => {
				await this.plugin.updateSettings({
					postProcessing: {
						...this.plugin.settings.postProcessing,
						enabled: value,
					},
				});
			},
		);
		this.addPostProcessingCommandSettings(containerEl, copy);
		this.addToggleSetting(
			containerEl,
			copy.fields.postProcessingOpenNote,
			this.plugin.settings.postProcessing.openNote,
			async (value) => {
				await this.plugin.updateSettings({
					postProcessing: {
						...this.plugin.settings.postProcessing,
						openNote: value,
					},
				});
			},
		);
	}

	private renderCaptureSettingsSection(
		containerEl: HTMLElement,
		copy: SettingsTabCopy,
	): void {
		this.addSectionHeading(containerEl, copy.sections.capture);
		this.addToggleSetting(
			containerEl,
			copy.fields.autoCapture,
			this.plugin.settings.autoCapture,
			async (value) => {
				await this.plugin.updateSettings({ autoCapture: value });
			},
		);
		this.addTextSetting(
			containerEl,
			copy.fields.pollIntervalMs,
			String(this.plugin.settings.pollIntervalMs),
			async (value) => {
				await this.plugin.updateSettings({
					pollIntervalMs: Number.parseInt(value, 10),
				});
			},
		);
		this.addTextSetting(
			containerEl,
			copy.fields.settleRepeatCount,
			String(this.plugin.settings.settleRepeatCount),
			async (value) => {
				await this.plugin.updateSettings({
					settleRepeatCount: Number.parseInt(value, 10),
				});
			},
		);
		this.addTextSetting(
			containerEl,
			copy.fields.settleTimeoutMs,
			String(this.plugin.settings.settleTimeoutMs),
			async (value) => {
				await this.plugin.updateSettings({
					settleTimeoutMs: Number.parseInt(value, 10),
				});
			},
		);
	}

	private renderDebugSettingsSection(
		containerEl: HTMLElement,
		copy: SettingsTabCopy,
	): void {
		this.addSectionHeading(containerEl, copy.sections.debug);
		this.addToggleSetting(
			containerEl,
			copy.fields.saveRawSnapshot,
			this.plugin.settings.saveRawSnapshot,
			async (value) => {
				await this.plugin.updateSettings({ saveRawSnapshot: value });
			},
		);
		this.addTextSetting(
			containerEl,
			copy.fields.maxHtmlSnippetLength,
			String(this.plugin.settings.maxHtmlSnippetLength),
			async (value) => {
				await this.plugin.updateSettings({
					maxHtmlSnippetLength: Number.parseInt(value, 10),
				});
			},
		);
		this.addToggleSetting(
			containerEl,
			copy.fields.debugMode,
			this.plugin.settings.debugMode,
			async (value) => {
				await this.plugin.updateSettings({ debugMode: value });
			},
		);
	}

	private addSectionHeading(containerEl: HTMLElement, title: string): void {
		new Setting(containerEl).setName(title).setHeading();
	}

	private addTextSetting(
		containerEl: HTMLElement,
		copy: SettingsTabCopy["fields"][keyof SettingsTabCopy["fields"]],
		value: string,
		onChange: (value: string) => Promise<void>,
	): Setting {
		const setting = new Setting(containerEl)
			.setName(copy.name)
			.setDesc(copy.description)
			.addText((text) => {
				if (copy.placeholder) {
					text.setPlaceholder(copy.placeholder);
				}

				return text.setValue(value).onChange(onChange);
			});
		return setting;
	}

	private addToggleSetting(
		containerEl: HTMLElement,
		copy: SettingsTabCopy["fields"][keyof SettingsTabCopy["fields"]],
		value: boolean,
		onChange: (value: boolean) => Promise<void>,
	): Setting {
		const setting = new Setting(containerEl)
			.setName(copy.name)
			.setDesc(copy.description)
			.addToggle((toggle) => toggle.setValue(value).onChange(onChange));
		return setting;
	}

	private addPostProcessingCommandSettings(
		containerEl: HTMLElement,
		copy: SettingsTabCopy,
	): void {
		const pickerSetting = new Setting(containerEl)
			.setName(copy.fields.postProcessingCommands.name)
			.setDesc(copy.fields.postProcessingCommands.description)
			.addButton((button) =>
				button
					.setButtonText(copy.actions.addPostProcessingCommand)
					.onClick(() => {
						this.openPostProcessingCommandPicker();
					}),
			);
		pickerSetting.settingEl.classList.add("obar-settings-action-row");

		const commandIds = this.plugin.settings.postProcessing.commandIds;
		if (commandIds.length === 0) {
			containerEl.createEl("p", {
				cls: "obar-post-processing-empty setting-item-description",
				text: copy.postProcessingList.empty,
			});
			return;
		}

		commandIds.forEach((commandId, index) => {
			const command = getObsidianCommand(this.app, commandId);
			const description = command
				? command.id
				: `${commandId} (${copy.postProcessingList.missingDescription})`;
			const setting = new Setting(containerEl)
				.setName(command?.name ?? copy.postProcessingList.missingName)
				.setDesc(description);
			setting.settingEl.classList.add("obar-post-processing-command");

			setting.addButton((button) =>
				button
					.setButtonText(copy.actions.moveCommandUp)
					.setDisabled(index === 0)
					.onClick(() => {
						void this.movePostProcessingCommand(index, -1);
					}),
			);
			setting.addButton((button) =>
				button
					.setButtonText(copy.actions.moveCommandDown)
					.setDisabled(index === commandIds.length - 1)
					.onClick(() => {
						void this.movePostProcessingCommand(index, 1);
					}),
			);
			setting.addButton((button) =>
				button
					.setButtonText(copy.actions.removePostProcessingCommand)
					.onClick(() => {
						void this.removePostProcessingCommand(index);
					}),
			);
		});
	}

	private addChatTargetSettings(
		containerEl: HTMLElement,
		copy: SettingsTabCopy,
	): void {
		const actionSetting = new Setting(containerEl)
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
		actionSetting.settingEl.classList.add("obar-settings-action-row");

		this.plugin.settings.chatTargets.forEach((rule, index) => {
			const setting = new Setting(containerEl)
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
			setting.settingEl.classList.add("obar-chat-target-rule");
			setting.controlEl.classList.add("obar-chat-target-rule-control");

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

	private openPostProcessingCommandPicker(): void {
		new CommandPickerModal(this.app, {
			excludedCommandIds: this.plugin.settings.postProcessing.commandIds,
			onChoose: (command) => {
				void this.appendPostProcessingCommand(command.id);
			},
		}).open();
	}

	private async appendPostProcessingCommand(commandId: string): Promise<void> {
		await this.plugin.updateSettings({
			postProcessing: {
				...this.plugin.settings.postProcessing,
				commandIds: [...this.plugin.settings.postProcessing.commandIds, commandId],
			},
		});
		this.display();
	}

	private async removePostProcessingCommand(index: number): Promise<void> {
		await this.plugin.updateSettings({
			postProcessing: {
				...this.plugin.settings.postProcessing,
				commandIds: this.plugin.settings.postProcessing.commandIds.filter(
					(_, candidateIndex) => candidateIndex !== index,
				),
			},
		});
		this.display();
	}

	private async movePostProcessingCommand(
		index: number,
		offset: -1 | 1,
	): Promise<void> {
		const commandIds = [...this.plugin.settings.postProcessing.commandIds];
		const targetIndex = index + offset;
		if (targetIndex < 0 || targetIndex >= commandIds.length) {
			return;
		}

		const currentCommandId = commandIds[index];
		const targetCommandId = commandIds[targetIndex];
		if (!currentCommandId || !targetCommandId) {
			return;
		}

		commandIds[index] = targetCommandId;
		commandIds[targetIndex] = currentCommandId;
		await this.plugin.updateSettings({
			postProcessing: {
				...this.plugin.settings.postProcessing,
				commandIds,
			},
		});
		this.display();
	}
}
