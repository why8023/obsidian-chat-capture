import {
	COLLECT_SNAPSHOT_SCRIPT,
	createBootstrapScript,
	HEALTHCHECK_SCRIPT,
} from "../capture/bootstrap-script";
import { StabilityDetector } from "../capture/stability-detector";
import type { SnapshotNormalizer } from "../capture/snapshot-normalizer";
import { DebugDumpWriter } from "../debug/debug-dump";
import { Logger } from "../debug/logger";
import { MarkdownWriter } from "../persistence/markdown-writer";
import { SessionIndex } from "../persistence/session-index";
import type {
	CaptureDiagnostics,
	ConversationSnapshot,
	PluginSettings,
	PluginStateData,
	ScriptExecutionResult,
	SerializedError,
	WebviewBinding,
} from "../types";
import { ViewerManager } from "../webviewer/viewer-manager";
import { RuntimeStateMachine } from "./state-machine";

class CaptureScriptError extends Error {
	constructor(
		readonly stage: string,
		readonly details: SerializedError,
		readonly diagnostics: CaptureDiagnostics,
	) {
		super(details.message);
		this.name = details.name ?? "CaptureScriptError";
		if (details.stack) {
			this.stack = details.stack;
		}
	}
}

interface RuntimeControllerDeps {
	settings: () => PluginSettings;
	state: () => PluginStateData;
	persistState: () => Promise<void>;
	viewerManager: ViewerManager;
	sessionIndex: SessionIndex;
	markdownWriter: MarkdownWriter;
	normalizer: SnapshotNormalizer;
	debugDump: DebugDumpWriter;
	logger: Logger;
	onStatusChange: (status: string) => void;
}

export class RuntimeController {
	private readonly stateMachine = new RuntimeStateMachine();
	private readonly stabilityDetector = new StabilityDetector();
	private pollTimer: number | null = null;
	private failureCount = 0;
	private isTicking = false;
	private forceReinject = false;
	private stopped = false;

	constructor(private readonly deps: RuntimeControllerDeps) {}

	async handleLayoutReady(): Promise<void> {
		await this.deps.viewerManager.restoreControlledViewer();
		if (this.deps.settings().autoCapture && !this.deps.state().capturePaused) {
			await this.resume("layout-ready");
			return;
		}

		this.deps.onStatusChange("Chat capture: paused");
	}

	async handleLayoutChange(): Promise<void> {
		this.forceReinject = true;
		if (this.deps.settings().autoCapture && !this.deps.state().capturePaused) {
			this.scheduleNextTick(500);
		}
	}

	async handleActiveLeafChange(): Promise<void> {
		if (this.deps.viewerManager.isControlledLeafActive()) {
			this.scheduleNextTick(250);
		}
	}

	async handleSettingsUpdated(): Promise<void> {
		this.forceReinject = true;
		if (this.deps.settings().autoCapture && !this.deps.state().capturePaused) {
			await this.resume("settings-updated");
			return;
		}

		this.clearTimer();
		this.deps.onStatusChange("Chat capture: paused");
	}

	async pause(reason: string): Promise<void> {
		this.deps.state().capturePaused = true;
		await this.deps.persistState();
		this.clearTimer();
		this.stateMachine.force("idle");
		this.deps.logger.info("Auto capture paused", { reason });
		this.deps.onStatusChange("Chat capture: paused");
	}

	async resume(reason: string): Promise<void> {
		this.stopped = false;
		this.deps.state().capturePaused = false;
		await this.deps.persistState();
		this.deps.logger.info("Auto capture resumed", { reason });
		this.scheduleNextTick(200);
	}

	stop(): void {
		this.stopped = true;
		this.clearTimer();
		this.stateMachine.force("idle");
	}

	async saveSnapshotNow(): Promise<boolean> {
		return this.captureOnce(true);
	}

	async reinject(): Promise<boolean> {
		const binding = await this.ensureBinding();
		if (!binding) {
			this.deps.onStatusChange("Chat capture: no Web Viewer bound");
			return false;
		}

		await this.ensureBootstrap(binding, true);
		this.deps.onStatusChange("Chat capture: capture script reinjected");
		return true;
	}

	private scheduleNextTick(delayMs: number): void {
		if (this.stopped || this.deps.state().capturePaused || !this.deps.settings().autoCapture) {
			return;
		}

		this.clearTimer();
		this.pollTimer = window.setTimeout(() => {
			void this.captureOnce(false);
		}, delayMs);
	}

	private clearTimer(): void {
		if (this.pollTimer !== null) {
			window.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private async captureOnce(forcePersist: boolean): Promise<boolean> {
		if (this.isTicking) {
			return false;
		}
		if (
			!forcePersist &&
			(this.deps.state().capturePaused || !this.deps.settings().autoCapture)
		) {
			return false;
		}

		this.isTicking = true;
		let nextDelay = this.deps.settings().pollIntervalMs;
		let captureStage = "binding";
		let binding: WebviewBinding | null = null;
		let diagnostics: CaptureDiagnostics | undefined;

		try {
			binding = await this.ensureBinding();
			if (!binding) {
				this.failureCount = 0;
				this.stateMachine.force("idle");
				this.deps.onStatusChange("Chat capture: no ChatGPT Web Viewer found");
				return false;
			}

			this.logDebug("Capture tick bound webview", {
				forcePersist,
				leafId: binding.leafId,
				url: binding.lastUrl,
			});

			captureStage = "bootstrap";
			diagnostics = await this.ensureBootstrap(binding, this.forceReinject);

			this.stateMachine.force("polling");
			captureStage = "collect";
			const collectResult =
				await binding.webview.executeJavaScript<
					ScriptExecutionResult<ConversationSnapshot | null>
				>(COLLECT_SNAPSHOT_SCRIPT);
			const rawSnapshot = this.unwrapScriptResult(collectResult);
			diagnostics = collectResult.diagnostics;
			this.logDebug("Capture collect completed", {
				leafId: binding.leafId,
				diagnostics,
				messageCount:
					Array.isArray(rawSnapshot?.messages) ? rawSnapshot.messages.length : 0,
			});

			if (!rawSnapshot) {
				this.deps.logger.warn("Collect returned no snapshot", {
					leafId: binding.leafId,
					url: binding.lastUrl,
					diagnostics,
				});
				this.deps.onStatusChange("Chat capture: collect returned no snapshot");
				return false;
			}

			captureStage = "normalize";
			await this.deps.debugDump.writeSnapshot("last-raw-snapshot", rawSnapshot);
			const normalized = this.deps.normalizer.normalize(rawSnapshot);
			await this.deps.debugDump.writeSnapshot("last-normalized-snapshot", normalized);

			captureStage = "stability-check";
			if (normalized.messages.length === 0) {
				this.deps.logger.warn("Snapshot contained no messages", {
					pageUrl: normalized.pageUrl,
					pageState: normalized.pageState,
					diagnostics,
				});
				nextDelay = this.nextIntervalFor(normalized.pageState, false);
				this.deps.onStatusChange("Chat capture: no messages detected");
				return false;
			}

			const stability = this.stabilityDetector.accept(normalized, this.deps.settings(), {
				force: forcePersist,
			});
			nextDelay = this.nextIntervalFor(normalized.pageState, !stability.readyToPersist);

			if (!stability.readyToPersist) {
				this.logDebug("Capture waiting for stability", {
					conversationKey: normalized.conversationKey,
					reason: stability.reason,
					messageCount: normalized.messages.length,
				});
				this.deps.onStatusChange("Chat capture: waiting for stable reply");
				return false;
			}

			this.stateMachine.force("saving");
			captureStage = "write-snapshot";
			const existingEntry = this.deps.sessionIndex.get(normalized.conversationKey);
			const filePath =
				existingEntry?.filePath ??
				(await this.deps.markdownWriter.resolveFilePath(
					normalized,
					this.deps.sessionIndex.entries().map((entry) => entry.filePath),
				));
			const merge = this.deps.sessionIndex.prepare(normalized, filePath);
			if (merge.skipReason) {
				this.deps.logger.warn("Skipped regressive snapshot", {
					conversationKey: normalized.conversationKey,
					reason: merge.skipReason,
				});
				this.deps.onStatusChange("Chat capture: skipped regressive snapshot");
				return false;
			}

			if (merge.changed) {
				await this.deps.markdownWriter.writeSnapshot(normalized, merge.entry);
				await this.deps.sessionIndex.commit(merge.entry);
			}

			this.failureCount = 0;
			this.deps.onStatusChange(
				merge.changed
					? `Chat capture: saved ${merge.entry.lastStableMessageCount} messages`
					: "Chat capture: up to date",
			);
			return merge.changed;
		} catch (error) {
			this.failureCount += 1;
			const backoffDelay = Math.min(
				this.deps.settings().pollIntervalMs * 2 ** this.failureCount,
				10_000,
			);
			nextDelay = backoffDelay;
			this.stateMachine.force("backoff");
			const serializedError = this.serializeError(error);
			const errorContext = {
				stage:
					error instanceof CaptureScriptError ? error.stage : captureStage,
				error: serializedError,
				failureCount: this.failureCount,
				backoffDelay,
				binding: binding
					? {
							leafId: binding.leafId,
							url: binding.lastUrl,
							status: binding.status,
						}
					: null,
				diagnostics:
					error instanceof CaptureScriptError
						? error.diagnostics
						: diagnostics,
			};
			this.deps.logger.error("Capture tick failed", errorContext);
			await this.deps.debugDump.writeRuntimeState({
				state: this.stateMachine.state,
				...errorContext,
				recentLogs: this.deps.logger.getEntries(50),
				capturedAt: new Date().toISOString(),
			});
			this.deps.onStatusChange("Chat capture: retrying after error");
			return false;
		} finally {
			this.isTicking = false;
			if (!forcePersist) {
				this.scheduleNextTick(nextDelay);
			}
		}
	}

	private async ensureBinding(): Promise<WebviewBinding | null> {
		let binding = this.deps.viewerManager.locateBoundWebview();
		if (binding) {
			return binding;
		}

		await this.deps.viewerManager.restoreControlledViewer();
		binding = this.deps.viewerManager.locateBoundWebview();
		if (binding) {
			return binding;
		}

		await this.deps.viewerManager.bindActiveChatGPTViewer();
		return this.deps.viewerManager.locateBoundWebview();
	}

	private async ensureBootstrap(
		binding: WebviewBinding,
		forceReinject: boolean,
	): Promise<CaptureDiagnostics | undefined> {
		this.stateMachine.force("injecting");
		await this.waitForDomReady(binding);

		let hasBootstrap = false;
		let diagnostics: CaptureDiagnostics | undefined;
		if (!forceReinject) {
			try {
				const healthResult =
					await binding.webview.executeJavaScript<
						ScriptExecutionResult<{
							ok?: boolean;
							messageCount?: number;
							pageState?: string;
							title?: string;
							url?: string;
						}>
					>(HEALTHCHECK_SCRIPT);
				diagnostics = healthResult.diagnostics;
				if (healthResult.ok) {
					hasBootstrap = Boolean(healthResult.value?.ok);
					this.logDebug("Capture healthcheck completed", {
						leafId: binding.leafId,
						url: binding.lastUrl,
						result: healthResult.value,
						diagnostics: healthResult.diagnostics,
					});
				} else {
					this.logDebug("Capture healthcheck requested reinjection", {
						leafId: binding.leafId,
						url: binding.lastUrl,
						error: healthResult.error,
						diagnostics: healthResult.diagnostics,
					});
				}
			} catch (error) {
				this.logDebug("Capture healthcheck threw", {
					leafId: binding.leafId,
					url: binding.lastUrl,
					error: this.serializeError(error),
				});
				hasBootstrap = false;
			}
		}

		if (!hasBootstrap || forceReinject) {
			const bootstrapResult =
				await binding.webview.executeJavaScript<
					ScriptExecutionResult<{
						installed: boolean;
						installedAt?: string;
						reusedExisting: boolean;
						version: string;
					}>
				>(createBootstrapScript(this.deps.settings().maxHtmlSnippetLength));
			const bootstrapInfo = this.unwrapScriptResult(bootstrapResult);
			diagnostics = bootstrapResult.diagnostics;
			this.deps.logger.info("Capture bootstrap injected", {
				leafId: binding.leafId,
				url: binding.lastUrl,
				reusedExisting: bootstrapInfo.reusedExisting,
				diagnostics: bootstrapResult.diagnostics,
			});
		} else {
			this.logDebug("Capture bootstrap already available", {
				leafId: binding.leafId,
				url: binding.lastUrl,
				diagnostics,
			});
		}

		this.forceReinject = false;
		return diagnostics;
	}

	private async waitForDomReady(binding: WebviewBinding): Promise<void> {
		try {
			const readyState = await binding.webview.executeJavaScript<string>(
				"document.readyState",
			);
			if (readyState === "interactive" || readyState === "complete") {
				this.logDebug("Webview DOM already ready", {
					leafId: binding.leafId,
					url: binding.lastUrl,
					readyState,
				});
				return;
			}
		} catch {
			// Ignore and fall back to a dom-ready listener.
		}

		let waitReason: "dom-ready" | "timeout" = "timeout";
		await new Promise<void>((resolve) => {
			let settled = false;
			const timer = window.setTimeout(() => done("timeout"), 4_000);

			const onReady = () => done("dom-ready");

			function done(reason: "dom-ready" | "timeout"): void {
				if (settled) {
					return;
				}
				settled = true;
				waitReason = reason;
				window.clearTimeout(timer);
				binding.webview.removeEventListener("dom-ready", onReady);
				resolve();
			}

			binding.webview.addEventListener("dom-ready", onReady);
		});

		this.logDebug("Webview DOM wait finished", {
			leafId: binding.leafId,
			url: binding.lastUrl,
			reason: waitReason,
		});
	}

	private nextIntervalFor(pageState: string, waitingForStability: boolean): number {
		if (pageState === "login" || pageState === "unknown") {
			return Math.max(this.deps.settings().pollIntervalMs * 2, 3_000);
		}

		if (waitingForStability) {
			return Math.min(this.deps.settings().pollIntervalMs, 1_000);
		}

		return this.deps.settings().pollIntervalMs;
	}

	private unwrapScriptResult<T>(result: ScriptExecutionResult<T>): T {
		if (!result.ok) {
			throw new CaptureScriptError(
				result.stage,
				result.error,
				result.diagnostics,
			);
		}

		return result.value;
	}

	private serializeError(error: unknown): SerializedError {
		if (error instanceof CaptureScriptError) {
			return error.details;
		}

		if (error instanceof Error) {
			return {
				message: error.message,
				name: error.name,
				stack: error.stack,
			};
		}

		return {
			message: String(error),
		};
	}

	private logDebug(message: string, context?: unknown): void {
		if (!this.deps.settings().debugMode) {
			return;
		}

		this.deps.logger.debug(message, context);
	}
}
