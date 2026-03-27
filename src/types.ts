export type ChatMessageRole = "user" | "ai" | "system" | "unknown";
export type PageState = "login" | "chat-list" | "session" | "unknown";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type WebviewActivityReason =
	| "dom-ready"
	| "did-navigate"
	| "did-navigate-in-page"
	| "did-fail-load"
	| "render-process-gone"
	| "destroyed";
export type RuntimeState =
	| "idle"
	| "bindingWebview"
	| "injecting"
	| "polling"
	| "saving"
	| "backoff";

export interface ChatTargetRule {
	urlPattern: string;
	saveFolder: string;
}

export interface PostProcessingSettings {
	enabled: boolean;
	commandIds: string[];
	openNote: boolean;
}

export interface PluginSettings {
	chatTargets: ChatTargetRule[];
	fileNameTemplate: string;
	sessionRoundSeparator: string;
	messageHeadingSummaryLength: number;
	postProcessing: PostProcessingSettings;
	openNoteAfterSave: boolean;
	pollIntervalMs: number;
	settleRepeatCount: number;
	settleTimeoutMs: number;
	autoCapture: boolean;
	saveRawSnapshot: boolean;
	maxHtmlSnippetLength: number;
	debugMode: boolean;
}

export interface TurnActionFlags {
	hasCopyButton: boolean;
	hasThumbActions: boolean;
}

export interface RawTurnShell {
	ordinal: number;
	role: ChatMessageRole;
	domKey: string;
	contentHtml: string;
	contentHtmlHash?: string;
	contentTextHint?: string;
	rawHtmlSnippet?: string;
	actionFlags?: Partial<TurnActionFlags>;
}

export interface SessionSnapshot {
	source: "obar-chatgpt-webviewer";
	extractorVersion: string;
	pageUrl: string;
	pageTitle: string;
	capturedAt: string;
	sessionId?: string;
	sessionTitle?: string;
	pageState: PageState;
	turns: RawTurnShell[];
}

export interface NormalizedMessage {
	uid: string;
	matchKey: string;
	ordinal: number;
	role: ChatMessageRole;
	text: string;
	markdown: string;
	textHash: string;
	domKey: string;
	contentHtmlHash: string;
	rawHtmlSnippet?: string;
	actionFlags: TurnActionFlags;
	hasCompletionActions: boolean;
}

export interface NormalizedSessionSnapshot {
	source: "obar-chatgpt-webviewer";
	extractorVersion: string;
	sessionId?: string;
	sessionKey: string;
	sessionTitle: string;
	pageUrl: string;
	pageTitle: string;
	capturedAt: number;
	pageState: PageState;
	messages: NormalizedMessage[];
	snapshotHash: string;
}

export interface SessionMessageIndex {
	uid: string;
	ordinal: number;
	role: ChatMessageRole;
	textHash: string;
}

export interface SessionIndexEntry {
	sessionKey: string;
	filePath: string;
	sessionUrl: string;
	sessionTitle?: string;
	createdAt: number;
	updatedAt: number;
	lastStableMessageCount: number;
	lastSnapshotHash: string;
	messages: SessionMessageIndex[];
}

export interface RecordEntry {
	filePath: string;
	sessionId?: string;
	sessionKey?: string;
	sessionUrl?: string;
	sessionTitle?: string;
	createdAt?: number;
	updatedAt?: number;
	messageCount?: number;
}

export interface PluginStateData {
	capturePaused: boolean;
}

export type PersistedPluginSettingsData = Partial<PluginSettings>;

export interface PersistedPluginData {
	settings?: PersistedPluginSettingsData;
	state?: Partial<PluginStateData>;
}

export interface ObarWebview extends HTMLElement {
	executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
	getURL?(): string;
	src?: string;
}

export interface WebviewBinding {
	leafId: string;
	webview: ObarWebview;
	boundAt: number;
	lastUrl: string;
	status: "pending" | "ready" | "lost";
}

export interface WebviewActivityEvent {
	reason: WebviewActivityReason;
	leafId: string;
	url?: string | null;
	isMainFrame?: boolean;
}

export interface StabilityState {
	sessionKey: string;
	lastAiUid?: string;
	firstSeenAt?: number;
	lastHash?: string;
	stableRepeatCount: number;
}

export interface StabilityDecision {
	readyToPersist: boolean;
	reason: string;
	snapshot: NormalizedSessionSnapshot;
}

export interface CaptureHealth {
	ok: boolean;
	url: string;
	title: string;
	pageState: PageState;
	messageCount: number | null;
	dirty: boolean;
	pendingUpdate: boolean;
	observed: boolean;
	visibilityState: string | null;
	lastMutationAt: number | null;
	lastSnapshotAt: number | null;
}

export interface CaptureDiagnostics {
	pageUrl: string | null;
	pageTitle: string;
	readyState: string;
	pageState?: PageState | null;
	hasCaptureApi: boolean;
	captureVersion: string | null;
	messageCount?: number | null;
	dirty?: boolean;
	pendingUpdate?: boolean;
	observed?: boolean;
	visibilityState?: string | null;
	lastMutationAt?: number | null;
	lastSnapshotAt?: number | null;
}

export interface SerializedError {
	message: string;
	name?: string;
	stack?: string;
}

export type CaptureRunStatus =
	| "saved"
	| "up-to-date"
	| "busy"
	| "paused"
	| "no-matching-viewer"
	| "watching-for-page-changes"
	| "collect-returned-no-snapshot"
	| "no-messages"
	| "waiting-for-stable-reply"
	| "waiting-for-session-id"
	| "skipped-regressive-snapshot"
	| "error";

interface BaseCaptureRunResult {
	status: CaptureRunStatus;
	statusMessage: string;
}

export interface CaptureSavedResult extends BaseCaptureRunResult {
	status: "saved";
	filePath: string;
	messageCount: number;
	created: boolean;
	newMessageCount: number;
	sessionTitle?: string;
}

export interface CaptureErrorResult extends BaseCaptureRunResult {
	status: "error";
	stage: string;
	error: SerializedError;
}

export interface CaptureIdleResult extends BaseCaptureRunResult {
	status: Exclude<CaptureRunStatus, "saved" | "error">;
}

export type CaptureRunResult =
	| CaptureSavedResult
	| CaptureErrorResult
	| CaptureIdleResult;

export interface ScriptExecutionSuccess<T> {
	ok: true;
	stage: string;
	value: T;
	diagnostics: CaptureDiagnostics;
}

export interface ScriptExecutionFailure {
	ok: false;
	stage: string;
	error: SerializedError;
	diagnostics: CaptureDiagnostics;
}

export type ScriptExecutionResult<T> =
	| ScriptExecutionSuccess<T>
	| ScriptExecutionFailure;

export interface LogEntry {
	level: LogLevel;
	message: string;
	context?: unknown;
	timestamp: number;
}
