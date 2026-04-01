import { type TFile } from "obsidian";
import {
	COLLECT_SNAPSHOT_SCRIPT,
	createBootstrapScript,
	HEALTHCHECK_SCRIPT,
	type HealthcheckResult,
} from "../capture/bootstrap-script";
import { EXTRACTOR_VERSION, formatObarUiText } from "../constants";
import { StabilityDetector } from "../capture/stability-detector";
import type { SnapshotNormalizer } from "../capture/snapshot-normalizer";
import { DebugDumpWriter } from "../debug/debug-dump";
import { Logger } from "../debug/logger";
import { RecordIndex } from "../persistence/record-index";
import { MarkdownWriter } from "../persistence/markdown-writer";
import { SessionIndex } from "../persistence/session-index";
import { MarkdownPostProcessor } from "../post-processing/markdown-post-processor";
import type {
	CaptureDiagnostics,
	CaptureErrorResult,
	CaptureIdleResult,
	CaptureRunResult,
	NormalizedSessionSnapshot,
	PluginSettings,
	PluginStateData,
	RecordEntry,
	RuntimeState,
	ScriptExecutionResult,
	SerializedError,
	SessionIndexEntry,
	SessionSnapshot,
	WebviewActivityEvent,
	WebviewBinding,
} from "../types";
import { ViewerManager } from "../webviewer/viewer-manager";

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
	recordIndex: RecordIndex;
	sessionIndex: SessionIndex;
	markdownWriter: MarkdownWriter;
	postProcessor: MarkdownPostProcessor;
	openNote: (file: TFile) => Promise<void>;
	normalizer: SnapshotNormalizer;
	debugDump: DebugDumpWriter;
	logger: Logger;
	onStatusChange: (status: string) => void;
	onCaptureResult: (result: CaptureRunResult) => void;
}

interface BootstrapState {
	diagnostics?: CaptureDiagnostics;
	health: HealthcheckResult;
}

interface PreparedCaptureContext {
	activeLeaf: boolean;
	binding: WebviewBinding;
	diagnostics?: CaptureDiagnostics;
	health: HealthcheckResult;
}

interface CollectedSnapshotContext extends PreparedCaptureContext {
	normalized: NormalizedSessionSnapshot;
}

type CollectedSnapshotResult =
	| {
			ok: true;
			context: CollectedSnapshotContext;
	  }
	| {
			ok: false;
			health: HealthcheckResult;
			result: CaptureIdleResult;
	  };

type CurrentSnapshotResult =
	| {
			status: "ok";
			snapshot: NormalizedSessionSnapshot;
	  }
	| CaptureIdleResult
	| CaptureErrorResult;

export class RuntimeController {
	private readonly stabilityDetector = new StabilityDetector();
	private pollTimer: number | null = null;
	private failureCount = 0;
	private isTicking = false;
	private forceReinject = false;
	private stopped = false;
	private awaitingStability = false;
	private runtimeState: RuntimeState = "idle";

	constructor(private readonly deps: RuntimeControllerDeps) {}

	async handleLayoutReady(): Promise<void> {
		if (this.deps.settings().autoCapture && !this.deps.state().capturePaused) {
			await this.resume("layout-ready");
			return;
		}

		this.setRuntimeState("idle");
		this.deps.onStatusChange(formatObarUiText("paused"));
	}

	async handleLayoutChange(): Promise<void> {
		this.forceReinject = true;
		if (this.deps.settings().autoCapture && !this.deps.state().capturePaused) {
			this.scheduleNextTick(
				this.deps.viewerManager.isAnyTrackedLeafActive()
					? 500
					: this.backgroundIdleDelay(),
			);
		}
	}

	async handleActiveLeafChange(): Promise<void> {
		if (this.deps.viewerManager.isAnyTrackedLeafActive()) {
			this.scheduleNextTick(250);
			return;
		}

		if (this.deps.settings().autoCapture && !this.deps.state().capturePaused) {
			this.scheduleNextTick(this.backgroundIdleDelay());
		}
	}

	async handleSettingsUpdated(): Promise<void> {
		this.forceReinject = true;
		if (this.deps.settings().autoCapture && !this.deps.state().capturePaused) {
			await this.resume("settings-updated");
			return;
		}

		this.clearTimer();
		this.deps.onStatusChange(formatObarUiText("paused"));
	}

	async pause(reason: string): Promise<void> {
		this.deps.state().capturePaused = true;
		await this.deps.persistState();
		this.clearTimer();
		this.setRuntimeState("idle");
		this.awaitingStability = false;
		this.deps.logger.info("Auto capture paused", { reason });
		this.deps.onStatusChange(formatObarUiText("paused"));
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
		this.setRuntimeState("idle");
		this.awaitingStability = false;
	}

	handleWebviewActivity(activity: WebviewActivityEvent): void {
		if (!this.deps.settings().autoCapture || this.deps.state().capturePaused) {
			return;
		}

		if (
			activity.reason === "dom-ready" ||
			activity.reason === "did-navigate" ||
			activity.reason === "did-navigate-in-page" ||
			activity.reason === "render-process-gone" ||
			activity.reason === "destroyed"
		) {
			this.forceReinject = true;
		}

		const delay =
			activity.reason === "dom-ready" ||
			activity.reason === "did-navigate" ||
			activity.reason === "did-navigate-in-page"
				? 150
				: 500;
		this.scheduleNextTick(delay);
	}

	async saveSnapshotNow(): Promise<CaptureRunResult> {
		return this.captureOnce(true);
	}

	async saveCollectedSnapshot(
		snapshot: NormalizedSessionSnapshot,
	): Promise<CaptureRunResult> {
		return this.persistSnapshot(snapshot);
	}

	async collectCurrentSnapshot(): Promise<CurrentSnapshotResult> {
		if (this.isTicking) {
			return {
				status: "busy",
				statusMessage: formatObarUiText("waiting for the current capture cycle"),
			};
		}

		this.isTicking = true;
		let captureStage = "binding";
		let preparedContext: PreparedCaptureContext | null = null;
		let diagnostics: CaptureDiagnostics | undefined;

		try {
			preparedContext = await this.prepareCaptureContext();
			if (!preparedContext) {
				const statusMessage = formatObarUiText("no matching Web Viewer found");
				this.setRuntimeState("idle");
				this.deps.onStatusChange(statusMessage);
				return {
					status: "no-matching-viewer",
					statusMessage,
				};
			}

			captureStage = "collect";
			const collected = await this.collectNormalizedSnapshot(preparedContext);
			diagnostics = preparedContext.diagnostics;
			if (!collected.ok) {
				this.deps.onStatusChange(collected.result.statusMessage);
				return collected.result;
			}
			diagnostics = collected.context.diagnostics;
			this.setRuntimeState("polling");

			return {
				status: "ok",
				snapshot: collected.context.normalized,
			};
		} catch (error) {
			const serializedError = this.serializeError(error);
			const stage = error instanceof CaptureScriptError ? error.stage : captureStage;
			this.deps.logger.error("Collecting current snapshot failed", {
				stage,
				error: serializedError,
				binding: preparedContext
					? {
							leafId: preparedContext.binding.leafId,
							url: preparedContext.binding.lastUrl,
							status: preparedContext.binding.status,
						}
					: null,
				diagnostics:
					error instanceof CaptureScriptError ? error.diagnostics : diagnostics,
			});
			const statusMessage = formatObarUiText("failed");
			this.setRuntimeState("idle");
			this.deps.onStatusChange(statusMessage);
			return {
				status: "error",
				statusMessage,
				stage,
				error: serializedError,
			};
		} finally {
			this.isTicking = false;
		}
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

	private async captureOnce(forcePersist: boolean): Promise<CaptureRunResult> {
		if (this.isTicking) {
			return this.reportResult({
				status: "busy",
				statusMessage: formatObarUiText("waiting for the current capture cycle"),
			});
		}
		if (
			!forcePersist &&
			(this.deps.state().capturePaused || !this.deps.settings().autoCapture)
		) {
			return this.reportResult({
				status: "paused",
				statusMessage: formatObarUiText("paused"),
			});
		}

		this.isTicking = true;
		let nextDelay = this.deps.settings().pollIntervalMs;
		let captureStage = "binding";
		let preparedContext: PreparedCaptureContext | null = null;
		let diagnostics: CaptureDiagnostics | undefined;

		try {
			preparedContext = await this.prepareCaptureContext();
			if (!preparedContext) {
				this.failureCount = 0;
				this.setRuntimeState("idle");
				this.awaitingStability = false;
				nextDelay = this.deps.viewerManager.isAnyTrackedLeafActive()
					? Math.min(this.deps.settings().pollIntervalMs, 1_000)
					: this.backgroundIdleDelay();
				const statusMessage = formatObarUiText("no matching Web Viewer found");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "no-matching-viewer",
					statusMessage,
				});
			}

			captureStage = "bootstrap";
			diagnostics = preparedContext.diagnostics;
			nextDelay = this.nextIntervalFor(
				preparedContext.health,
				preparedContext.activeLeaf,
				this.awaitingStability,
			);

			if (!forcePersist && !this.shouldCollectSnapshot(preparedContext.health)) {
				this.failureCount = 0;
				this.setRuntimeState("polling");
				const statusMessage = formatObarUiText("watching for page changes");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "watching-for-page-changes",
					statusMessage,
				});
			}

			captureStage = "collect";
			this.setRuntimeState("polling");
			const collected = await this.collectNormalizedSnapshot(preparedContext);
			if (!collected.ok) {
				diagnostics = preparedContext.diagnostics;
				this.awaitingStability = false;
				nextDelay = this.nextIntervalFor(
					collected.health,
					preparedContext.activeLeaf,
					this.awaitingStability,
				);
				this.deps.onStatusChange(collected.result.statusMessage);
				return this.reportResult(collected.result);
			}

			diagnostics = collected.context.diagnostics;
			const normalized = collected.context.normalized;
			captureStage = "stability-check";
			const stability = this.stabilityDetector.accept(normalized, this.deps.settings(), {
				force: forcePersist,
			});
			this.awaitingStability = !stability.readyToPersist;
			nextDelay = this.nextIntervalFor(
				collected.context.health,
				preparedContext.activeLeaf,
				this.awaitingStability,
			);

			if (!stability.readyToPersist) {
				this.logDebug("Capture waiting for stability", {
					sessionKey: normalized.sessionKey,
					reason: stability.reason,
					messageCount: normalized.messages.length,
				});
				const statusMessage = formatObarUiText("waiting for stable reply");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "waiting-for-stable-reply",
					statusMessage,
				});
			}

			if (!normalized.sessionId) {
				nextDelay = Math.min(this.deps.settings().pollIntervalMs, 1_000);
				const statusMessage = formatObarUiText("waiting for session id");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "waiting-for-session-id",
					statusMessage,
				});
			}

			captureStage = "write-snapshot";
			const persistResult = await this.persistSnapshot(normalized, {
				forceWrite: forcePersist,
			});
			this.failureCount = 0;
			this.awaitingStability = false;
			return this.reportResult(persistResult);
		} catch (error) {
			this.failureCount += 1;
			const backoffDelay = Math.min(
				this.deps.settings().pollIntervalMs * 2 ** this.failureCount,
				10_000,
			);
			nextDelay = backoffDelay;
			this.setRuntimeState("backoff");
			const serializedError = this.serializeError(error);
			const errorContext = {
				stage:
					error instanceof CaptureScriptError ? error.stage : captureStage,
				error: serializedError,
				failureCount: this.failureCount,
				backoffDelay,
				binding: preparedContext
					? {
							leafId: preparedContext.binding.leafId,
							url: preparedContext.binding.lastUrl,
							status: preparedContext.binding.status,
						}
					: null,
				diagnostics:
					error instanceof CaptureScriptError ? error.diagnostics : diagnostics,
			};
			this.deps.logger.error("Capture tick failed", errorContext);
			await this.deps.debugDump.writeRuntimeState({
				state: this.runtimeState,
				...errorContext,
				recentLogs: this.deps.logger.getEntries(50),
				capturedAt: new Date().toISOString(),
			});
			const statusMessage = forcePersist
				? formatObarUiText("failed")
				: formatObarUiText("retrying after error");
			this.deps.onStatusChange(statusMessage);
			return this.reportResult({
				status: "error",
				statusMessage,
				stage: errorContext.stage,
				error: serializedError,
			});
		} finally {
			this.isTicking = false;
			if (!forcePersist) {
				this.scheduleNextTick(nextDelay);
			}
		}
	}

	private async prepareCaptureContext(): Promise<PreparedCaptureContext | null> {
		this.setRuntimeState("bindingWebview");
		const binding = await this.ensureBinding();
		if (!binding) {
			return null;
		}

		const activeLeaf = this.deps.viewerManager.isLeafActive(binding.leafId);
		this.logDebug("Capture tick bound webview", {
			leafId: binding.leafId,
			url: binding.lastUrl,
		});
		const bootstrapState = await this.ensureBootstrap(binding, this.forceReinject);
		this.logDebug("Capture healthcheck completed", {
			leafId: binding.leafId,
			url: binding.lastUrl,
			health: bootstrapState.health,
			diagnostics: bootstrapState.diagnostics,
		});
		return {
			activeLeaf,
			binding,
			diagnostics: bootstrapState.diagnostics,
			health: bootstrapState.health,
		};
	}

	private async collectNormalizedSnapshot(
		context: PreparedCaptureContext,
	): Promise<CollectedSnapshotResult> {
		const collectResult =
			await context.binding.webview.executeJavaScript<
				ScriptExecutionResult<SessionSnapshot | null>
			>(COLLECT_SNAPSHOT_SCRIPT);
		const rawSnapshot = this.unwrapScriptResult(collectResult);
		const diagnostics = collectResult.diagnostics;
		const collectedHealth = this.mergeHealthWithDiagnostics(
			context.health,
			context.binding.lastUrl,
			diagnostics,
		);
		this.logDebug("Capture collect completed", {
			leafId: context.binding.leafId,
			diagnostics,
			messageCount: Array.isArray(rawSnapshot?.turns) ? rawSnapshot.turns.length : 0,
		});

		if (!rawSnapshot) {
			this.deps.logger.warn("Collect returned no snapshot", {
				leafId: context.binding.leafId,
				url: context.binding.lastUrl,
				diagnostics,
			});
			return {
				ok: false,
				health: collectedHealth,
				result: {
					status: "collect-returned-no-snapshot",
					statusMessage: formatObarUiText("collect returned no snapshot"),
				},
			};
		}

		await this.deps.debugDump.writeSnapshot("last-raw-snapshot", rawSnapshot);
		const normalized = await this.deps.normalizer.normalize(rawSnapshot);
		await this.deps.debugDump.writeSnapshot("last-normalized-snapshot", normalized);

		if (normalized.messages.length === 0) {
			this.deps.logger.warn("Snapshot contained no messages", {
				pageUrl: normalized.pageUrl,
				pageState: normalized.pageState,
				diagnostics,
			});
			return {
				ok: false,
				health: {
					...collectedHealth,
					pageState: normalized.pageState,
					messageCount: 0,
					lastSnapshotAt: normalized.capturedAt,
				},
				result: {
					status: "no-messages",
					statusMessage: formatObarUiText("no messages detected"),
				},
			};
		}

		return {
			ok: true,
			context: {
				...context,
				diagnostics,
				health: {
					...collectedHealth,
					pageState: normalized.pageState,
					messageCount: normalized.messages.length,
					lastSnapshotAt: normalized.capturedAt,
				},
				normalized,
			},
		};
	}

	private mergeHealthWithDiagnostics(
		health: HealthcheckResult,
		fallbackUrl: string,
		diagnostics: CaptureDiagnostics,
	): HealthcheckResult {
		return {
			ok: true,
			url: diagnostics.pageUrl ?? fallbackUrl,
			title: diagnostics.pageTitle,
			pageState: diagnostics.pageState ?? health.pageState,
			messageCount: diagnostics.messageCount ?? null,
			dirty: diagnostics.dirty ?? false,
			pendingUpdate: diagnostics.pendingUpdate ?? false,
			observed: diagnostics.observed ?? health.observed,
			visibilityState: diagnostics.visibilityState ?? health.visibilityState,
			lastMutationAt: diagnostics.lastMutationAt ?? health.lastMutationAt,
			lastSnapshotAt: diagnostics.lastSnapshotAt ?? Date.now(),
		};
	}

	private async persistSnapshot(
		normalized: NormalizedSessionSnapshot,
		options?: {
			forceWrite?: boolean;
		},
	): Promise<CaptureRunResult> {
		const forceWrite = options?.forceWrite ?? false;
		if (!normalized.sessionId) {
			const statusMessage = formatObarUiText("waiting for session id");
			this.deps.onStatusChange(statusMessage);
			return {
				status: "waiting-for-session-id",
				statusMessage,
			};
		}

		this.setRuntimeState("saving");
		const existingRecord = this.deps.recordIndex.findMatch(normalized);
		const existingEntry = this.reconcileSessionEntryWithRecord(
			this.deps.sessionIndex.findMatch(normalized),
			existingRecord,
		);
		const knownFilePaths = this.getKnownFilePaths();
		const filePath =
			existingEntry?.filePath ??
			existingRecord?.filePath ??
			(await this.deps.markdownWriter.resolveFilePath(normalized, knownFilePaths));
		const merge = this.deps.sessionIndex.prepare(normalized, filePath, existingRecord);
		if (merge.skipReason) {
			this.deps.logger.warn("Skipped regressive snapshot", {
				sessionKey: normalized.sessionKey,
				reason: merge.skipReason,
			});
			const statusMessage = formatObarUiText("skipped regressive snapshot");
			this.deps.onStatusChange(statusMessage);
			this.setRuntimeState("polling");
			return {
				status: "skipped-regressive-snapshot",
				statusMessage,
			};
		}

		const rewriteFrontmatterTimestamps =
			!forceWrite &&
			!merge.changed &&
			(await this.deps.markdownWriter.needsFrontmatterTimestampRewrite(
				merge.entry.filePath,
			));
		const rewriteMissingFile =
			!merge.changed && !this.deps.markdownWriter.hasFile(merge.entry.filePath);
		const shouldWrite =
			merge.changed || rewriteFrontmatterTimestamps || rewriteMissingFile || forceWrite;
		let persistedEntry =
			rewriteFrontmatterTimestamps
				? {
						...merge.entry,
						createdAt:
							existingEntry?.createdAt ??
							existingRecord?.createdAt ??
							merge.entry.createdAt,
						updatedAt:
							existingEntry?.updatedAt ??
							existingRecord?.updatedAt ??
							merge.entry.updatedAt,
						lastStableMessageCount:
							existingEntry?.lastStableMessageCount ??
							existingRecord?.messageCount ??
							merge.entry.lastStableMessageCount,
					}
				: merge.entry;
		let writtenFile: TFile | null = null;

		if (shouldWrite) {
			const previousTitle =
				existingEntry?.sessionTitle ?? existingRecord?.sessionTitle;
			persistedEntry = {
				...persistedEntry,
				filePath: await this.deps.markdownWriter.reconcileManagedFilePath(
					normalized,
					persistedEntry,
					previousTitle,
					knownFilePaths,
				),
			};
			writtenFile = await this.deps.markdownWriter.writeSnapshot(
				normalized,
				persistedEntry,
			);
			this.deps.recordIndex.upsertFromSession(normalized, persistedEntry);
			if (rewriteMissingFile) {
				this.deps.logger.info("Record restored after missing file", {
					sessionKey: normalized.sessionKey,
					filePath: persistedEntry.filePath,
				});
			}
		}
		if (merge.changed || merge.replacedKeys.length > 0 || rewriteMissingFile || forceWrite) {
			await this.deps.sessionIndex.commit(persistedEntry, merge.replacedKeys);
		}
		if (writtenFile && (merge.changed || forceWrite)) {
			const noteOpenedByPostProcessor = await this.deps.postProcessor.run(writtenFile);
			if (this.deps.settings().openNoteAfterSave && !noteOpenedByPostProcessor) {
				await this.deps.openNote(writtenFile);
			}
		}

		this.setRuntimeState("polling");
		if (merge.changed || rewriteMissingFile || forceWrite) {
			const statusMessage = formatObarUiText(
				`saved ${persistedEntry.lastStableMessageCount} messages`,
			);
			this.deps.onStatusChange(statusMessage);
			return {
				status: "saved",
				statusMessage,
				filePath: persistedEntry.filePath,
				messageCount: persistedEntry.lastStableMessageCount,
				created: merge.created,
				newMessageCount: merge.newMessages.length,
				sessionTitle: persistedEntry.sessionTitle,
			};
		}

		const statusMessage = formatObarUiText("up to date");
		this.deps.onStatusChange(statusMessage);
		return {
			status: "up-to-date",
			statusMessage,
		};
	}

	private getKnownFilePaths(): string[] {
		return [
			...this.deps.recordIndex.filePaths(),
			...this.deps.sessionIndex
				.entries()
				.map((entry) => entry.filePath)
				.filter((filePath) => this.deps.markdownWriter.hasFile(filePath)),
		];
	}

	private async ensureBinding(): Promise<WebviewBinding | null> {
		return this.deps.viewerManager.locateBestWebview();
	}

	private async ensureBootstrap(
		binding: WebviewBinding,
		forceReinject: boolean,
	): Promise<BootstrapState> {
		this.setRuntimeState("injecting");
		await this.waitForDomReady(binding);

		let hasBootstrap = false;
		let diagnostics: CaptureDiagnostics | undefined;
		let health: HealthcheckResult | null = null;
		if (!forceReinject) {
			try {
				const healthResult =
					await binding.webview.executeJavaScript<ScriptExecutionResult<HealthcheckResult>>(
						HEALTHCHECK_SCRIPT,
					);
				diagnostics = healthResult.diagnostics;
				if (healthResult.ok) {
					health = healthResult.value;
					hasBootstrap =
						Boolean(health.ok) &&
						healthResult.diagnostics.captureVersion === EXTRACTOR_VERSION;
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
			const postBootstrapHealth =
				await binding.webview.executeJavaScript<ScriptExecutionResult<HealthcheckResult>>(
					HEALTHCHECK_SCRIPT,
				);
			health = this.unwrapScriptResult(postBootstrapHealth);
			diagnostics = postBootstrapHealth.diagnostics;
		}

		this.forceReinject = false;
		if (!health) {
			const healthResult =
				await binding.webview.executeJavaScript<ScriptExecutionResult<HealthcheckResult>>(
					HEALTHCHECK_SCRIPT,
				);
			health = this.unwrapScriptResult(healthResult);
			diagnostics = healthResult.diagnostics;
		}

		return {
			diagnostics,
			health,
		};
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

	private shouldCollectSnapshot(health: HealthcheckResult): boolean {
		if (health.dirty || health.pendingUpdate) {
			return true;
		}

		if (this.awaitingStability) {
			return true;
		}

		if (health.lastSnapshotAt === null) {
			return true;
		}

		if (
			health.pageState === "session" &&
			this.hasStableSessionIdentity({ pageUrl: health.url }) &&
			!this.deps.recordIndex.hasRecordForUrl(health.url)
		) {
			return true;
		}

		return false;
	}

	private backgroundIdleDelay(): number {
		return Math.max(this.deps.settings().pollIntervalMs * 10, 15_000);
	}

	private hasStableSessionIdentity(snapshot: {
		sessionId?: string;
		pageUrl: string;
	}): boolean {
		return Boolean(snapshot.sessionId) || /\/c\/[^/?#]+/i.test(snapshot.pageUrl);
	}

	private reconcileSessionEntryWithRecord(
		entry: SessionIndexEntry | undefined,
		record: RecordEntry | undefined,
	): SessionIndexEntry | undefined {
		if (!entry || !record) {
			return entry;
		}

		return {
			...entry,
			filePath: record.filePath || entry.filePath,
			sessionUrl: record.sessionUrl ?? entry.sessionUrl,
			sessionTitle: record.sessionTitle ?? entry.sessionTitle,
		};
	}

	private nextIntervalFor(
		health: HealthcheckResult,
		activeLeaf: boolean,
		waitingForStability: boolean,
	): number {
		const baseInterval = this.deps.settings().pollIntervalMs;
		const hidden = health.visibilityState === "hidden";

		if (health.pageState === "login" || health.pageState === "unknown") {
			return activeLeaf && !hidden
				? Math.max(baseInterval * 6, 10_000)
				: Math.max(baseInterval * 12, 20_000);
		}

		if (health.pageState === "chat-list") {
			return activeLeaf && !hidden
				? Math.max(baseInterval * 4, 8_000)
				: this.backgroundIdleDelay();
		}

		if (waitingForStability) {
			return Math.min(baseInterval, 1_000);
		}

		if (health.dirty || health.pendingUpdate) {
			return activeLeaf && !hidden
				? Math.min(baseInterval, 1_000)
				: Math.max(baseInterval * 2, 2_500);
		}

		if (!activeLeaf || hidden) {
			return this.backgroundIdleDelay();
		}

		return Math.max(baseInterval * 3, 5_000);
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

	private reportResult<T extends CaptureRunResult>(result: T): T {
		this.deps.onCaptureResult(result);
		return result;
	}

	private setRuntimeState(nextState: RuntimeState): void {
		this.runtimeState = nextState;
	}

	private logDebug(message: string, context?: unknown): void {
		if (!this.deps.settings().debugMode) {
			return;
		}

		this.deps.logger.debug(message, context);
	}
}
