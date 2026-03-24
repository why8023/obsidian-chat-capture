import { Notice, Plugin } from "obsidian";
import {
	DEFAULT_PLUGIN_STATE,
	DEFAULT_SETTINGS,
	LOG_BUFFER_LIMIT,
} from "./constants";
import { registerCommands } from "./commands";
import { SnapshotNormalizer } from "./capture/snapshot-normalizer";
import { DebugDumpWriter } from "./debug/debug-dump";
import { CaptureLogModal, Logger } from "./debug/logger";
import { MarkdownWriter } from "./persistence/markdown-writer";
import { SessionIndex } from "./persistence/session-index";
import { RuntimeController } from "./runtime/runtime-controller";
import { normalizePersistedData, normalizePluginSettings } from "./settings/settings";
import { ChatCaptureSettingTab } from "./settings/setting-tab";
import type {
	PersistedPluginData,
	PluginSettings,
	PluginStateData,
} from "./types";
import { ViewerManager } from "./webviewer/viewer-manager";

export default class ObsidianChatCapturePlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	state: PluginStateData = DEFAULT_PLUGIN_STATE;
	logger!: Logger;
	debugDump!: DebugDumpWriter;
	sessionIndex!: SessionIndex;
	markdownWriter!: MarkdownWriter;
	viewerManager!: ViewerManager;
	runtime!: RuntimeController;
	private statusBarEl!: HTMLElement;

	async onload(): Promise<void> {
		await this.loadPluginData();

		this.logger = new Logger(LOG_BUFFER_LIMIT);
		this.debugDump = new DebugDumpWriter(
			this.app,
			this.manifest,
			() => this.settings.debugMode || this.settings.saveRawSnapshot,
			this.logger,
		);
		this.sessionIndex = new SessionIndex(this.state, () => this.persistPluginData());
		this.markdownWriter = new MarkdownWriter(
			this.app,
			() => this.settings,
			this.logger,
		);
		this.viewerManager = new ViewerManager(
			this.app,
			this.logger,
			() => this.state,
			() => this.persistPluginData(),
		);
		this.runtime = new RuntimeController({
			settings: () => this.settings,
			state: () => this.state,
			persistState: () => this.persistPluginData(),
			viewerManager: this.viewerManager,
			sessionIndex: this.sessionIndex,
			markdownWriter: this.markdownWriter,
			normalizer: new SnapshotNormalizer(),
			debugDump: this.debugDump,
			logger: this.logger,
			onStatusChange: (status) => this.setStatus(status),
		});

		this.statusBarEl = this.addStatusBarItem();
		this.setStatus("Chat capture: idle");

		this.addRibbonIcon("messages-square", "Open web viewer", () => {
			void this.openChatGPTViewer();
		});
		this.addSettingTab(new ChatCaptureSettingTab(this.app, this));
		registerCommands(this);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				void this.runtime.handleActiveLeafChange();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				void this.runtime.handleLayoutChange();
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			void this.runtime.handleLayoutReady();
		});
	}

	onunload(): void {
		this.runtime?.stop();
		this.viewerManager?.dispose();
	}

	async openChatGPTViewer(): Promise<void> {
		const leaf = await this.viewerManager.openChatGPTInWebViewer(this.settings.chatgptUrl);
		await this.viewerManager.bindLeaf(leaf);
		this.setStatus("Chat capture: viewer opened");
		if (this.settings.autoCapture && !this.state.capturePaused) {
			await this.runtime.resume("viewer-opened");
		}
		new Notice("Opened web viewer.");
	}

	async bindCurrentViewer(): Promise<boolean> {
		const ref = await this.viewerManager.bindActiveChatGPTViewer();
		if (!ref) {
			new Notice("Active tab is not a compatible web viewer.");
			return false;
		}

		this.setStatus("Chat capture: viewer bound");
		if (this.settings.autoCapture && !this.state.capturePaused) {
			await this.runtime.resume("viewer-bound");
		}
		new Notice("Bound the active web viewer.");
		return true;
	}

	async saveSnapshotNow(): Promise<boolean> {
		const saved = await this.runtime.saveSnapshotNow();
		new Notice(saved ? "Current snapshot saved." : "No snapshot was saved.");
		return saved;
	}

	async reinjectCaptureScript(): Promise<boolean> {
		const injected = await this.runtime.reinject();
		new Notice(
			injected
				? "Capture script reinjected."
				: "Failed to reinject the capture script.",
		);
		return injected;
	}

	async pauseAutoCapture(): Promise<void> {
		await this.runtime.pause("command");
		new Notice("Auto capture paused.");
	}

	async resumeAutoCapture(): Promise<void> {
		if (!this.settings.autoCapture) {
			new Notice("Auto capture is disabled in settings.");
			return;
		}

		await this.runtime.resume("command");
		new Notice("Auto capture resumed.");
	}

	openCaptureLog(): void {
		new CaptureLogModal(this.app, this.logger.getEntries()).open();
	}

	async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
		this.settings = normalizePluginSettings({
			...this.settings,
			...patch,
		});
		await this.persistPluginData();
		await this.runtime.handleSettingsUpdated();
	}

	private setStatus(status: string): void {
		this.statusBarEl?.setText(status);
	}

	private async loadPluginData(): Promise<void> {
		const data = (await this.loadData()) as PersistedPluginData | null;
		const normalized = normalizePersistedData(data);
		this.settings = normalized.settings;
		this.state = normalized.state;
	}

	private async persistPluginData(): Promise<void> {
		const payload: PersistedPluginData = {
			settings: this.settings,
			state: this.state,
		};
		await this.saveData(payload);
	}
}
