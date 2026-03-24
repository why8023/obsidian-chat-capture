import { App, type WorkspaceLeaf } from "obsidian";
import type {
	ChatCaptureWebview,
	LogLevel,
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

interface RankedBinding {
	binding: WebviewBinding;
	score: number;
}

export class ViewerManager {
	private readonly locator = new WebviewLocator();
	private readonly observedWebviews = new WeakSet<ChatCaptureWebview>();
	private readonly cleanupCallbacks = new Set<() => void>();
	private readonly recentActivityAt = new Map<string, number>();
	private activityHandler: ((activity: WebviewActivityEvent) => void) | null = null;
	private preferredLeafId: string | null = null;

	constructor(
		private readonly app: App,
		private readonly logger: Logger,
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

	async bindActiveChatGPTViewer(): Promise<string | null> {
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		if (!activeLeaf) {
			return null;
		}

		return this.bindLeaf(activeLeaf);
	}

	async bindLeaf(leaf: WorkspaceLeaf): Promise<string | null> {
		const url = getLeafWebViewerUrl(leaf);
		if (!isChatGPTUrl(url)) {
			return null;
		}

		const leafId = getLeafId(leaf);
		this.preferredLeafId = leafId;
		this.recentActivityAt.set(leafId, Date.now());
		this.logger.info("Prioritized ChatGPT Web Viewer", {
			leafId,
			url,
		});
		return leafId;
	}

	setActivityHandler(handler: ((activity: WebviewActivityEvent) => void) | null): void {
		this.activityHandler = handler;
	}

	locateBestWebview(): WebviewBinding | null {
		const ranked = this.collectRankedBindings();
		return ranked[0]?.binding ?? null;
	}

	isAnyChatGPTLeafActive(): boolean {
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		return activeLeaf ? isChatGPTUrl(getLeafWebViewerUrl(activeLeaf)) : false;
	}

	isLeafActive(leafId: string): boolean {
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		return activeLeaf ? getLeafId(activeLeaf) === leafId : false;
	}

	dispose(): void {
		for (const cleanup of this.cleanupCallbacks) {
			cleanup();
		}
		this.cleanupCallbacks.clear();
		this.recentActivityAt.clear();
	}

	private collectRankedBindings(): RankedBinding[] {
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		const activeLeafId = activeLeaf ? getLeafId(activeLeaf) : null;
		const now = Date.now();

		return this.getChatGPTLeaves()
			.map((leaf) => {
				const binding = this.locator.locateForLeaf(leaf);
				if (!binding) {
					return null;
				}

				this.observeWebview(binding);
				const recentActivityAt = this.recentActivityAt.get(binding.leafId) ?? 0;
				const recentlyActive = recentActivityAt > 0 && now - recentActivityAt < 15_000;
				const stableConversationUrl = /\/c\/[^/?#]+/i.test(binding.lastUrl);
				const score =
					(binding.leafId === activeLeafId ? 12 : 0) +
					(binding.leafId === this.preferredLeafId ? 8 : 0) +
					(recentlyActive ? 6 : 0) +
					(stableConversationUrl ? 2 : 0);
				return {
					binding,
					score,
				};
			})
			.filter((candidate): candidate is RankedBinding => candidate !== null)
			.sort((left, right) => right.score - left.score);
	}

	private getChatGPTLeaves(): WorkspaceLeaf[] {
		const leaves = this.app.workspace.getLeavesOfType("webviewer");
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		const ordered: WorkspaceLeaf[] = [];
		const seen = new Set<string>();

		if (activeLeaf && isChatGPTUrl(getLeafWebViewerUrl(activeLeaf))) {
			const activeLeafId = getLeafId(activeLeaf);
			ordered.push(activeLeaf);
			seen.add(activeLeafId);
		}

		for (const leaf of leaves) {
			const leafId = getLeafId(leaf);
			if (seen.has(leafId) || !isChatGPTUrl(getLeafWebViewerUrl(leaf))) {
				continue;
			}

			ordered.push(leaf);
			seen.add(leafId);
		}

		return ordered;
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

		const emitActivity = (
			reason: WebviewActivityEvent["reason"],
			url: string | null | undefined,
			isMainFrame: boolean,
		): void => {
			this.recentActivityAt.set(leafId, Date.now());
			this.activityHandler?.({
				reason,
				leafId,
				url,
				isMainFrame,
			});
		};

		addListener<Event>("dom-ready", () => {
			const url = safeGetWebviewUrl(webview) ?? binding.lastUrl;
			this.logger.info("Webview DOM ready", {
				leafId,
				url,
			});
			emitActivity("dom-ready", url, true);
		});

		addListener<WebviewNavigationEvent>("did-navigate", (event) => {
			const url = event.url ?? safeGetWebviewUrl(webview) ?? binding.lastUrl;
			this.logger.info("Webview navigated", {
				leafId,
				url,
				isMainFrame: event.isMainFrame ?? true,
			});
			if (event.isMainFrame ?? true) {
				emitActivity("did-navigate", url, event.isMainFrame ?? true);
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
				emitActivity("did-navigate-in-page", url, event.isMainFrame ?? true);
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
				emitActivity("did-fail-load", url, event.isMainFrame ?? true);
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
			emitActivity("render-process-gone", url, true);
		});

		addListener<Event>("destroyed", () => {
			const url = safeGetWebviewUrl(webview) ?? binding.lastUrl;
			this.logger.warn("Webview destroyed", {
				leafId,
				url,
			});
			emitActivity("destroyed", url, true);
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
