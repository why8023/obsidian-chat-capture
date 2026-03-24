import { App, type WorkspaceLeaf } from "obsidian";
import { CHATGPT_URL_PREFIXES } from "../constants";
import type {
	ChatCaptureWebview,
	ControlledViewerRef,
	LogLevel,
	PluginStateData,
	WebviewActivityEvent,
	WebviewBinding,
} from "../types";
import { Logger } from "../debug/logger";
import {
	getLeafId,
	getLeafWebViewerUrl,
	isChatGPTUrl,
	safeGetWebviewUrl,
	WebviewLocator,
} from "./webview-locator";

type PersistState = () => Promise<void>;

interface WebviewConsoleMessageEvent extends Event {
	level?: number;
	line?: number;
	message?: string;
	sourceId?: string;
}

interface WebviewNavigationEvent extends Event {
	isMainFrame?: boolean;
	url?: string;
}

interface WebviewDidFailLoadEvent extends Event {
	errorCode?: number;
	errorDescription?: string;
	isMainFrame?: boolean;
	validatedURL?: string;
}

interface WebviewRenderProcessGoneEvent extends Event {
	exitCode?: number;
	reason?: string;
}

export class ViewerManager {
	private readonly locator = new WebviewLocator();
	private readonly observedWebviews = new WeakSet<ChatCaptureWebview>();
	private readonly cleanupCallbacks = new Set<() => void>();
	private activityHandler: ((activity: WebviewActivityEvent) => void) | null = null;

	constructor(
		private readonly app: App,
		private readonly logger: Logger,
		private readonly getState: () => PluginStateData,
		private readonly persistState: PersistState,
	) {}

	async openChatGPTInWebViewer(url: string): Promise<WorkspaceLeaf> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: "webviewer",
			active: true,
			state: {
				url,
				navigate: true,
			},
		} as never);
		await this.app.workspace.revealLeaf(leaf);
		this.logger.info("Opened ChatGPT in Web Viewer", { url });
		return leaf;
	}

	async bindActiveChatGPTViewer(): Promise<ControlledViewerRef | null> {
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		if (!activeLeaf) {
			return null;
		}

		return this.bindLeaf(activeLeaf);
	}

	async bindLeaf(leaf: WorkspaceLeaf): Promise<ControlledViewerRef | null> {
		const url = getLeafWebViewerUrl(leaf);
		if (!isChatGPTUrl(url)) {
			return null;
		}

		const ref: ControlledViewerRef = {
			leafId: getLeafId(leaf),
			expectedUrlPrefix:
				CHATGPT_URL_PREFIXES.find((prefix) => url?.startsWith(prefix)) ??
				CHATGPT_URL_PREFIXES[0] ??
				"https://chatgpt.com/",
			createdAt: this.getState().controlledViewer?.createdAt ?? Date.now(),
			lastSeenAt: Date.now(),
		};

		this.getState().controlledViewer = ref;
		await this.persistState();
		this.logger.info("Bound ChatGPT Web Viewer", {
			leafId: ref.leafId,
			url,
		});
		return ref;
	}

	getControlledLeaf(): WorkspaceLeaf | null {
		const ref = this.getState().controlledViewer;
		const webviewerLeaves = this.app.workspace.getLeavesOfType("webviewer");

		if (!ref) {
			return null;
		}

		for (const leaf of webviewerLeaves) {
			const url = getLeafWebViewerUrl(leaf);
			if (!isChatGPTUrl(url)) {
				continue;
			}

			if (getLeafId(leaf) === ref.leafId) {
				return leaf;
			}
		}

		for (const leaf of webviewerLeaves) {
			const url = getLeafWebViewerUrl(leaf);
			if (url?.startsWith(ref.expectedUrlPrefix)) {
				return leaf;
			}
		}

		return null;
	}

	async restoreControlledViewer(): Promise<ControlledViewerRef | null> {
		const leaf = this.getControlledLeaf() ?? this.findAnyChatGPTLeaf();
		if (!leaf) {
			return null;
		}

		return this.bindLeaf(leaf);
	}

	setActivityHandler(handler: ((activity: WebviewActivityEvent) => void) | null): void {
		this.activityHandler = handler;
	}

	locateBoundWebview(): WebviewBinding | null {
		const leaf = this.getControlledLeaf() ?? this.findAnyChatGPTLeaf();
		if (!leaf) {
			return null;
		}

		const binding = this.locator.locateForLeaf(leaf);
		if (!binding) {
			return null;
		}

		const ref = this.getState().controlledViewer;
		if (ref) {
			ref.lastSeenAt = Date.now();
		}
		this.observeWebview(binding);
		return binding;
	}

	isControlledLeafActive(): boolean {
		const controlledLeaf = this.getControlledLeaf();
		return (
			controlledLeaf !== null &&
			controlledLeaf === this.app.workspace.getMostRecentLeaf()
		);
	}

	dispose(): void {
		for (const cleanup of this.cleanupCallbacks) {
			cleanup();
		}
		this.cleanupCallbacks.clear();
	}

	private findAnyChatGPTLeaf(): WorkspaceLeaf | null {
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		if (activeLeaf && isChatGPTUrl(getLeafWebViewerUrl(activeLeaf))) {
			return activeLeaf;
		}

		return (
			this.app.workspace
				.getLeavesOfType("webviewer")
				.find((leaf) => isChatGPTUrl(getLeafWebViewerUrl(leaf))) ?? null
		);
	}

	private observeWebview(binding: WebviewBinding): void {
		const { webview, leafId } = binding;
		if (this.observedWebviews.has(webview)) {
			return;
		}

		this.observedWebviews.add(webview);
		const addListener = <T extends Event>(
			eventName: string,
			handler: (event: T) => void,
		): void => {
			const listener = handler as EventListener;
			webview.addEventListener(eventName, listener);
			const cleanup = () => {
				webview.removeEventListener(eventName, listener);
				this.cleanupCallbacks.delete(cleanup);
			};
			this.cleanupCallbacks.add(cleanup);
		};

		addListener<Event>("dom-ready", () => {
			const url = safeGetWebviewUrl(webview) ?? binding.lastUrl;
			this.logger.info("Webview DOM ready", {
				leafId,
				url,
			});
			this.activityHandler?.({
				reason: "dom-ready",
				leafId,
				url,
				isMainFrame: true,
			});
		});

		addListener<WebviewNavigationEvent>("did-navigate", (event) => {
			const url = event.url ?? safeGetWebviewUrl(webview) ?? binding.lastUrl;
			this.logger.info("Webview navigated", {
				leafId,
				url,
				isMainFrame: event.isMainFrame ?? true,
			});
			if (event.isMainFrame ?? true) {
				this.activityHandler?.({
					reason: "did-navigate",
					leafId,
					url,
					isMainFrame: event.isMainFrame ?? true,
				});
			}
		});

		addListener<WebviewNavigationEvent>("did-navigate-in-page", (event) => {
			const url = event.url ?? safeGetWebviewUrl(webview) ?? binding.lastUrl;
			this.logger.info("Webview navigated in page", {
				leafId,
				url,
				isMainFrame: event.isMainFrame ?? true,
			});
			if (event.isMainFrame ?? true) {
				this.activityHandler?.({
					reason: "did-navigate-in-page",
					leafId,
					url,
					isMainFrame: event.isMainFrame ?? true,
				});
			}
		});

		addListener<WebviewDidFailLoadEvent>("did-fail-load", (event) => {
			const url =
				event.validatedURL ??
				safeGetWebviewUrl(webview) ??
				binding.lastUrl;
			this.logger.warn("Webview failed to load", {
				leafId,
				url,
				isMainFrame: event.isMainFrame ?? true,
				errorCode: event.errorCode,
				errorDescription: event.errorDescription,
			});
			if (event.isMainFrame ?? true) {
				this.activityHandler?.({
					reason: "did-fail-load",
					leafId,
					url,
					isMainFrame: event.isMainFrame ?? true,
				});
			}
		});

		addListener<WebviewConsoleMessageEvent>("console-message", (event) => {
			const level = this.mapConsoleLevel(event.level);
			this.logAtLevel(level, `Webview console ${level}`, {
				leafId,
				url: safeGetWebviewUrl(webview) ?? binding.lastUrl,
				consoleLevel: event.level,
				message: event.message ?? "",
				line: event.line,
				sourceId: event.sourceId,
			});
		});

		addListener<WebviewRenderProcessGoneEvent>("render-process-gone", (event) => {
			const url = safeGetWebviewUrl(webview) ?? binding.lastUrl;
			this.logger.error("Webview render process gone", {
				leafId,
				url,
				reason: event.reason,
				exitCode: event.exitCode,
			});
			this.activityHandler?.({
				reason: "render-process-gone",
				leafId,
				url,
				isMainFrame: true,
			});
		});

		addListener<Event>("destroyed", () => {
			const url = safeGetWebviewUrl(webview) ?? binding.lastUrl;
			this.logger.warn("Webview destroyed", {
				leafId,
				url,
			});
			this.activityHandler?.({
				reason: "destroyed",
				leafId,
				url,
				isMainFrame: true,
			});
		});
	}

	private logAtLevel(level: LogLevel, message: string, context: unknown): void {
		switch (level) {
			case "error":
				this.logger.error(message, context);
				return;
			case "warn":
				this.logger.warn(message, context);
				return;
			case "info":
				this.logger.info(message, context);
				return;
			default:
				this.logger.debug(message, context);
		}
	}

	private mapConsoleLevel(level?: number): LogLevel {
		switch (level) {
			case 3:
				return "error";
			case 2:
				return "warn";
			case 1:
				return "info";
			default:
				return "debug";
		}
	}
}
