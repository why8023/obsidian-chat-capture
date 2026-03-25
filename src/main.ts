import { Notice, Plugin } from "obsidian";
import {
	DEFAULT_PLUGIN_STATE,
	DEFAULT_SETTINGS,
	LOG_BUFFER_LIMIT,
	formatObarUiText,
} from "./constants";
import { registerCommands } from "./commands";
import { SnapshotNormalizer } from "./capture/snapshot-normalizer";
import { DebugDumpWriter } from "./debug/debug-dump";
import { Logger } from "./debug/logger";
import { ConversationNoteIndex } from "./persistence/conversation-note-index";
import { MarkdownWriter } from "./persistence/markdown-writer";
import { SessionIndex } from "./persistence/session-index";
import { MarkdownPostProcessor } from "./post-processing/markdown-post-processor";
import { RuntimeController } from "./runtime/runtime-controller";
import {
	getPrimaryChatTarget,
	getTrackedSaveFolders,
} from "./settings/chat-targets";
import { normalizePersistedData, normalizePluginSettings } from "./settings/settings";
import { ObarSettingTab } from "./settings/setting-tab";
import { CaptureNoticeManager } from "./ui/capture-notice-manager";
import type {
	CaptureRunResult,
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
	postProcessor!: MarkdownPostProcessor;
	viewerManager!: ViewerManager;
	runtime!: RuntimeController;
	captureNotices!: CaptureNoticeManager;
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
		this.postProcessor = new MarkdownPostProcessor(
			this.app,
			() => this.settings,
			this.logger,
		);
		this.captureNotices = new CaptureNoticeManager();
		this.viewerManager = new ViewerManager(
			this.app,
			() => this.settings,
			this.logger,
		);
		this.runtime = new RuntimeController({
			settings: () => this.settings,
			state: () => this.state,
			persistState: () => this.persistPluginData(),
			viewerManager: this.viewerManager,
			noteIndex: this.noteIndex,
			sessionIndex: this.sessionIndex,
			markdownWriter: this.markdownWriter,
			postProcessor: this.postProcessor,
			normalizer: new SnapshotNormalizer(),
			debugDump: this.debugDump,
			logger: this.logger,
			onStatusChange: (status) => this.setStatus(status),
			onCaptureResult: (result) => this.captureNotices.handleCaptureResult(result),
		});
		this.viewerManager.setActivityHandler((activity) => {
			this.runtime.handleWebviewActivity(activity);
		});

		this.statusBarEl = this.addStatusBarItem();
		this.setStatus(formatObarUiText("idle"));

		this.addRibbonIcon("messages-square", "Open configured chat web viewer", () => {
			void this.openConfiguredChatViewer();
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
		this.captureNotices?.dispose();
	}

	async openConfiguredChatViewer(): Promise<void> {
		const target = getPrimaryChatTarget(this.settings);
		if (!target) {
			new Notice(formatObarUiText("No active chat URL rule is configured."));
			return;
		}

		const leaf = await this.viewerManager.openUrlInWebViewer(target.urlPattern);
		await this.viewerManager.bindLeaf(leaf);
		this.setStatus(formatObarUiText("viewer opened"));
		if (this.settings.autoCapture && !this.state.capturePaused) {
			await this.runtime.resume("viewer-opened");
		}
		new Notice(formatObarUiText("Opened the configured chat web viewer."));
	}

	async bindCurrentViewer(): Promise<boolean> {
		const ref = await this.viewerManager.bindActiveCompatibleViewer();
		if (!ref) {
			new Notice(
				formatObarUiText("Active tab does not match any configured chat URL rule."),
			);
			return false;
		}

		this.setStatus(formatObarUiText("viewer bound"));
		if (this.settings.autoCapture && !this.state.capturePaused) {
			await this.runtime.resume("viewer-bound");
		}
		new Notice(formatObarUiText("Bound the active web viewer."));
		return true;
	}

	async saveSnapshotNow(): Promise<CaptureRunResult> {
		const result = await this.runtime.saveSnapshotNow();
		if (result.status !== "saved" && result.status !== "error") {
			new Notice(result.statusMessage);
		}
		return result;
	}

	async pauseAutoCapture(): Promise<void> {
		await this.runtime.pause("command");
		new Notice(formatObarUiText("Auto capture paused."));
	}

	async resumeAutoCapture(): Promise<void> {
		if (!this.settings.autoCapture) {
			new Notice(formatObarUiText("Auto capture is disabled in settings."));
			return;
		}

		await this.runtime.resume("command");
		new Notice(formatObarUiText("Auto capture resumed."));
	}

	async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
		const previousTrackedFolders = getTrackedSaveFolders(this.settings);
		this.settings = normalizePluginSettings({
			...this.settings,
			...patch,
		});
		await this.persistPluginData();
		const nextTrackedFolders = getTrackedSaveFolders(this.settings);
		if (
			previousTrackedFolders.length !== nextTrackedFolders.length ||
			previousTrackedFolders.some((folder, index) => folder !== nextTrackedFolders[index])
		) {
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
