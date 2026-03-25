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
import { ConversationNoteIndex } from "../persistence/conversation-note-index";
import { MarkdownWriter } from "../persistence/markdown-writer";
import { SessionIndex } from "../persistence/session-index";
import { MarkdownPostProcessor } from "../post-processing/markdown-post-processor";
import type {
	CaptureErrorResult,
	CaptureIdleResult,
	CaptureRunResult,
	CaptureDiagnostics,
	ConversationNoteEntry,
	ConversationSnapshot,
	NormalizedSnapshot,
	PluginSettings,
	PluginStateData,
	ScriptExecutionResult,
	SerializedError,
	SessionIndexEntry,
	WebviewActivityEvent,
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
	noteIndex: ConversationNoteIndex;
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

type CurrentSnapshotResult =
	| {
			status: "ok";
			snapshot: NormalizedSnapshot;
	  }
	| CaptureIdleResult
	| CaptureErrorResult;

export class RuntimeController {
	private readonly stateMachine = new RuntimeStateMachine();
	private readonly stabilityDetector = new StabilityDetector();
	private pollTimer: number | null = null;
	private failureCount = 0;
	private isTicking = false;
	private forceReinject = false;
	private stopped = false;
	private awaitingStability = false;

	constructor(private readonly deps: RuntimeControllerDeps) {}

	async handleLayoutReady(): Promise<void> {
		if (this.deps.settings().autoCapture && !this.deps.state().capturePaused) {
			await this.resume("layout-ready");
			return;
		}

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
		this.stateMachine.force("idle");
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
		this.stateMachine.force("idle");
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

	async collectCurrentSnapshot(): Promise<CurrentSnapshotResult> {
		if (this.isTicking) {
			return {
				status: "busy",
				statusMessage: formatObarUiText("waiting for the current capture cycle"),
			};
		}

		this.isTicking = true;
		let captureStage = "binding";
		let binding: WebviewBinding | null = null;
		let diagnostics: CaptureDiagnostics | undefined;

		try {
			binding = await this.ensureBinding();
			if (!binding) {
				const statusMessage = formatObarUiText("no matching Web Viewer found");
				this.deps.onStatusChange(statusMessage);
				return {
					status: "no-matching-viewer",
					statusMessage,
				};
			}

			captureStage = "bootstrap";
			const bootstrapState = await this.ensureBootstrap(binding, this.forceReinject);
			diagnostics = bootstrapState.diagnostics;

			captureStage = "collect";
			const collectResult =
				await binding.webview.executeJavaScript<
					ScriptExecutionResult<ConversationSnapshot | null>
				>(COLLECT_SNAPSHOT_SCRIPT);
			const rawSnapshot = this.unwrapScriptResult(collectResult);
			diagnostics = collectResult.diagnostics;

			if (!rawSnapshot) {
				const statusMessage = formatObarUiText("collect returned no snapshot");
				this.deps.onStatusChange(statusMessage);
				return {
					status: "collect-returned-no-snapshot",
					statusMessage,
				};
			}

			captureStage = "normalize";
			await this.deps.debugDump.writeSnapshot("last-raw-snapshot", rawSnapshot);
			const normalized = await this.deps.normalizer.normalize(rawSnapshot);
			await this.deps.debugDump.writeSnapshot("last-normalized-snapshot", normalized);

			if (normalized.messages.length === 0) {
				const statusMessage = formatObarUiText("no messages detected");
				this.deps.onStatusChange(statusMessage);
				return {
					status: "no-messages",
					statusMessage,
				};
			}

			return {
				status: "ok",
				snapshot: normalized,
			};
		} catch (error) {
			const serializedError = this.serializeError(error);
			const stage = error instanceof CaptureScriptError ? error.stage : captureStage;
			this.deps.logger.error("Collecting current snapshot failed", {
				stage,
				error: serializedError,
				binding: binding
					? {
							leafId: binding.leafId,
							url: binding.lastUrl,
							status: binding.status,
						}
					: null,
				diagnostics:
					error instanceof CaptureScriptError ? error.diagnostics : diagnostics,
			});
			const statusMessage = formatObarUiText("failed");
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
		let binding: WebviewBinding | null = null;
		let diagnostics: CaptureDiagnostics | undefined;
		let activeLeaf = false;

		try {
			binding = await this.ensureBinding();
			if (!binding) {
				this.failureCount = 0;
				this.stateMachine.force("idle");
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

			activeLeaf = this.deps.viewerManager.isLeafActive(binding.leafId);

			this.logDebug("Capture tick bound webview", {
				forcePersist,
				leafId: binding.leafId,
				url: binding.lastUrl,
			});

			captureStage = "bootstrap";
			const bootstrapState = await this.ensureBootstrap(binding, this.forceReinject);
			diagnostics = bootstrapState.diagnostics;
			let health = bootstrapState.health;
			nextDelay = this.nextIntervalFor(health, activeLeaf, this.awaitingStability);
			this.logDebug("Capture healthcheck completed", {
				leafId: binding.leafId,
				url: binding.lastUrl,
				health,
				diagnostics,
			});

			if (!forcePersist && !this.shouldCollectSnapshot(health)) {
				this.failureCount = 0;
				this.stateMachine.force("polling");
				const statusMessage = formatObarUiText("watching for page changes");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "watching-for-page-changes",
					statusMessage,
				});
			}

			this.stateMachine.force("polling");
			captureStage = "collect";
			const collectResult =
				await binding.webview.executeJavaScript<
					ScriptExecutionResult<ConversationSnapshot | null>
				>(COLLECT_SNAPSHOT_SCRIPT);
			const rawSnapshot = this.unwrapScriptResult(collectResult);
			diagnostics = collectResult.diagnostics;
			health = {
				ok: true,
				url: diagnostics.pageUrl ?? binding.lastUrl,
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
			this.logDebug("Capture collect completed", {
				leafId: binding.leafId,
				diagnostics,
				messageCount: Array.isArray(rawSnapshot?.turns) ? rawSnapshot.turns.length : 0,
			});

			if (!rawSnapshot) {
				this.deps.logger.warn("Collect returned no snapshot", {
					leafId: binding.leafId,
					url: binding.lastUrl,
					diagnostics,
				});
				this.awaitingStability = false;
				nextDelay = this.nextIntervalFor(health, activeLeaf, this.awaitingStability);
				const statusMessage = formatObarUiText("collect returned no snapshot");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "collect-returned-no-snapshot",
					statusMessage,
				});
			}

			captureStage = "normalize";
			await this.deps.debugDump.writeSnapshot("last-raw-snapshot", rawSnapshot);
			const normalized = await this.deps.normalizer.normalize(rawSnapshot);
			await this.deps.debugDump.writeSnapshot("last-normalized-snapshot", normalized);

			captureStage = "stability-check";
			if (normalized.messages.length === 0) {
				this.deps.logger.warn("Snapshot contained no messages", {
					pageUrl: normalized.pageUrl,
					pageState: normalized.pageState,
					diagnostics,
				});
				this.awaitingStability = false;
				nextDelay = this.nextIntervalFor(
					{
						...health,
						pageState: normalized.pageState,
						messageCount: 0,
						lastSnapshotAt: normalized.capturedAt,
					},
					activeLeaf,
					this.awaitingStability,
				);
				const statusMessage = formatObarUiText("no messages detected");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "no-messages",
					statusMessage,
				});
			}

			const stability = this.stabilityDetector.accept(normalized, this.deps.settings(), {
				force: forcePersist,
			});
			this.awaitingStability = !stability.readyToPersist;
			nextDelay = this.nextIntervalFor(
				{
					...health,
					pageState: normalized.pageState,
					messageCount: normalized.messages.length,
					lastSnapshotAt: normalized.capturedAt,
				},
				activeLeaf,
				this.awaitingStability,
			);

			if (!stability.readyToPersist) {
				this.logDebug("Capture waiting for stability", {
					conversationKey: normalized.conversationKey,
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

			if (
				!forcePersist &&
				!this.hasStableConversationIdentity(normalized) &&
				!this.deps.noteIndex.findMatch(normalized) &&
				!this.deps.sessionIndex.get(normalized.conversationKey)
			) {
				nextDelay = Math.min(this.deps.settings().pollIntervalMs, 1_000);
				const statusMessage = formatObarUiText("waiting for conversation id");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "waiting-for-conversation-id",
					statusMessage,
				});
			}

			this.stateMachine.force("saving");
			captureStage = "write-snapshot";
			const existingNote = this.deps.noteIndex.findMatch(normalized);
			const rawExistingEntry = this.deps.sessionIndex.get(normalized.conversationKey);
			const existingEntry = this.reconcileSessionEntryWithNote(
				rawExistingEntry,
				existingNote,
			);
			if (
				rawExistingEntry &&
				existingEntry &&
				!this.isSameSessionEntryReference(rawExistingEntry, existingEntry)
			) {
				await this.deps.sessionIndex.commit(existingEntry);
			}
			const knownFilePaths = [
				...this.deps.noteIndex.filePaths(),
				...this.deps.sessionIndex
					.entries()
					.map((entry) => entry.filePath)
					.filter((filePath) => this.deps.markdownWriter.hasFile(filePath)),
			];
			const filePath =
				existingEntry?.filePath ??
				existingNote?.filePath ??
				(await this.deps.markdownWriter.resolveFilePath(normalized, knownFilePaths));
			const merge = this.deps.sessionIndex.prepare(normalized, filePath, existingNote);
			if (merge.skipReason) {
				this.deps.logger.warn("Skipped regressive snapshot", {
					conversationKey: normalized.conversationKey,
					reason: merge.skipReason,
				});
				this.awaitingStability = false;
				const statusMessage = formatObarUiText("skipped regressive snapshot");
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "skipped-regressive-snapshot",
					statusMessage,
				});
			}

			const rewriteFrontmatterTimestamps =
				!merge.changed &&
				(await this.deps.markdownWriter.needsFrontmatterTimestampRewrite(
					merge.entry.filePath,
				));
			const rewriteMissingFile =
				!merge.changed && !this.deps.markdownWriter.hasFile(merge.entry.filePath);
			let persistedEntry =
				rewriteFrontmatterTimestamps
					? {
							...merge.entry,
							createdAt:
								existingEntry?.createdAt ??
								existingNote?.createdAt ??
								merge.entry.createdAt,
							updatedAt:
								existingEntry?.updatedAt ??
								existingNote?.updatedAt ??
								merge.entry.updatedAt,
							lastStableMessageCount:
								existingEntry?.lastStableMessageCount ??
								existingNote?.messageCount ??
								merge.entry.lastStableMessageCount,
						}
					: merge.entry;
			let writtenFile: TFile | null = null;

			if (merge.changed || rewriteFrontmatterTimestamps || rewriteMissingFile) {
				const previousTitle = existingEntry?.title ?? existingNote?.title;
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
				this.deps.noteIndex.upsertFromSnapshot(normalized, persistedEntry);
				if (rewriteMissingFile) {
					this.deps.logger.info("Conversation note restored after missing file", {
						conversationKey: normalized.conversationKey,
						filePath: persistedEntry.filePath,
					});
				}
			}
			if (merge.changed || merge.replacedKeys.length > 0 || rewriteMissingFile) {
				await this.deps.sessionIndex.commit(persistedEntry, merge.replacedKeys);
			}
			if (merge.changed && writtenFile) {
				const noteOpenedByPostProcessor = await this.deps.postProcessor.run(
					writtenFile,
				);
				if (
					this.deps.settings().openNoteAfterSave &&
					!noteOpenedByPostProcessor
				) {
					await this.deps.openNote(writtenFile);
				}
			}

			this.failureCount = 0;
			this.awaitingStability = false;
			if (merge.changed || rewriteMissingFile) {
				const statusMessage = formatObarUiText(
					`saved ${persistedEntry.lastStableMessageCount} messages`,
				);
				this.deps.onStatusChange(statusMessage);
				return this.reportResult({
					status: "saved",
					statusMessage,
					filePath: persistedEntry.filePath,
					messageCount: persistedEntry.lastStableMessageCount,
					created: merge.created,
					newMessageCount: merge.newMessages.length,
					title: persistedEntry.title,
				});
			}

			const statusMessage = formatObarUiText("up to date");
			this.deps.onStatusChange(statusMessage);
			return this.reportResult({
				status: "up-to-date",
				statusMessage,
			});
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

	private async ensureBinding(): Promise<WebviewBinding | null> {
		return this.deps.viewerManager.locateBestWebview();
	}

	private async ensureBootstrap(
		binding: WebviewBinding,
		forceReinject: boolean,
	): Promise<BootstrapState> {
		this.stateMachine.force("injecting");
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
			health.pageState === "conversation" &&
			this.hasStableConversationIdentity({ pageUrl: health.url }) &&
			!this.deps.noteIndex.hasConversationForUrl(health.url)
		) {
			return true;
		}

		return false;
	}

	private backgroundIdleDelay(): number {
		return Math.max(this.deps.settings().pollIntervalMs * 10, 15_000);
	}

	private hasStableConversationIdentity(snapshot: {
		conversationId?: string;
		pageUrl: string;
	}): boolean {
		return Boolean(snapshot.conversationId) || /\/c\/[^/?#]+/i.test(snapshot.pageUrl);
	}

	private reconcileSessionEntryWithNote(
		entry: SessionIndexEntry | undefined,
		note: ConversationNoteEntry | undefined,
	): SessionIndexEntry | undefined {
		if (!entry || !note) {
			return entry;
		}

		return {
			...entry,
			filePath: note.filePath || entry.filePath,
			sourceUrl: note.chatUrl ?? entry.sourceUrl,
			title: note.title ?? entry.title,
		};
	}

	private isSameSessionEntryReference(
		left: SessionIndexEntry,
		right: SessionIndexEntry,
	): boolean {
		return (
			left.filePath === right.filePath &&
			left.sourceUrl === right.sourceUrl &&
			left.title === right.title
		);
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

	private logDebug(message: string, context?: unknown): void {
		if (!this.deps.settings().debugMode) {
			return;
		}

		this.deps.logger.debug(message, context);
	}
}
