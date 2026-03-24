import { Notice, Plugin } from "obsidian";
import {
	DEFAULT_PLUGIN_STATE,
	DEFAULT_SETTINGS,
	LOG_BUFFER_LIMIT,
} from "./constants";
import { registerCommands } from "./commands";
import { SnapshotNormalizer } from "./capture/snapshot-normalizer";
import { DebugDumpWriter } from "./debug/debug-dump";
import { Logger, ObarLogModal } from "./debug/logger";
import { ConversationNoteIndex } from "./persistence/conversation-note-index";
import { MarkdownWriter } from "./persistence/markdown-writer";
import { SessionIndex } from "./persistence/session-index";
import { RuntimeController } from "./runtime/runtime-controller";
import { normalizePersistedData, normalizePluginSettings } from "./settings/settings";
import { ObarSettingTab } from "./settings/setting-tab";
import type {
	PersistedPluginData,
	PluginSettings,
	PluginStateData,
} from "./types";
import { ViewerManager } from "./webviewer/viewer-manager";

export default class ObarPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	state: PluginStateData = DEFAULT_PLUGIN_STATE;
	logger!: Logger;
	debugDump!: DebugDumpWriter;
	noteIndex!: ConversationNoteIndex;
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
		this.noteIndex = new ConversationNoteIndex(
			this.app,
			() => this.settings,
			this.logger,
		);
		await this.noteIndex.rebuild();
		this.sessionIndex = new SessionIndex();
		this.markdownWriter = new MarkdownWriter(
			this.app,
			() => this.settings,
			this.logger,
		);
		this.viewerManager = new ViewerManager(this.app, this.logger);
		this.runtime = new RuntimeController({
			settings: () => this.settings,
			state: () => this.state,
			persistState: () => this.persistPluginData(),
			viewerManager: this.viewerManager,
			noteIndex: this.noteIndex,
			sessionIndex: this.sessionIndex,
			markdownWriter: this.markdownWriter,
			normalizer: new SnapshotNormalizer(),
			debugDump: this.debugDump,
			logger: this.logger,
			onStatusChange: (status) => this.setStatus(status),
		});
		this.viewerManager.setActivityHandler((activity) => {
			this.runtime.handleWebviewActivity(activity);
		});

		this.statusBarEl = this.addStatusBarItem();
		this.setStatus("OBAR: idle");

		this.addRibbonIcon("messages-square", "Open ChatGPT web viewer", () => {
			void this.openChatGPTViewer();
		});
		this.addSettingTab(new ObarSettingTab(this.app, this));
		registerCommands(this);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				this.noteIndex.handleMetadataChanged(file, cache);
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on("deleted", (file) => {
				this.noteIndex.handleMetadataDeleted(file);
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				void this.noteIndex.rebuild();
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.noteIndex.handleVaultTouch(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.noteIndex.handleVaultTouch(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.noteIndex.handleVaultRename(file, oldPath);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.noteIndex.handleVaultDelete(file);
			}),
		);
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
		this.setStatus("OBAR: viewer opened");
		if (this.settings.autoCapture && !this.state.capturePaused) {
			await this.runtime.resume("viewer-opened");
		}
		new Notice("Opened the ChatGPT web viewer.");
	}

	async bindCurrentViewer(): Promise<boolean> {
		const ref = await this.viewerManager.bindActiveChatGPTViewer();
		if (!ref) {
			new Notice("Active tab is not a compatible web viewer.");
			return false;
		}

		this.setStatus("OBAR: viewer bound");
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
				? "OBAR capture script reinjected."
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

	openObarLog(): void {
		new ObarLogModal(this.app, this.logger.getEntries()).open();
	}

	async migrateLegacyConversationProperties(): Promise<number> {
		const filePaths = this.noteIndex.filePaths();
		let migratedCount = 0;

		for (const filePath of filePaths) {
			if (await this.markdownWriter.migrateLegacyFrontmatter(filePath)) {
				migratedCount += 1;
			}
		}

		if (migratedCount > 0) {
			await this.noteIndex.rebuild();
			new Notice(`Migrated ${migratedCount} note(s) to OBAR properties.`);
			return migratedCount;
		}

		new Notice("No legacy conversation properties were found.");
		return 0;
	}

	async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
		const previousSaveFolder = this.settings.saveFolder;
		this.settings = normalizePluginSettings({
			...this.settings,
			...patch,
		});
		await this.persistPluginData();
		if (previousSaveFolder !== this.settings.saveFolder) {
			await this.noteIndex.rebuild();
		}
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
