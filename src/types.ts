export type ChatMessageRole = "user" | "assistant" | "system" | "unknown";
export type PageState = "login" | "chat-list" | "conversation" | "unknown";
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
	| "openingViewer"
	| "bindingWebview"
	| "injecting"
	| "polling"
	| "saving"
	| "backoff"
	| "error";

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
	conversationRoundSeparator: string;
	messageHeadingSummaryLength: number;
	postProcessing: PostProcessingSettings;
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

export interface ConversationSnapshot {
	source: "obar-chatgpt-webviewer";
	extractorVersion: string;
	pageUrl: string;
	pageTitle: string;
	capturedAt: string;
	conversationId?: string;
	conversationTitle?: string;
	pageState: PageState;
	turns: RawTurnShell[];
}

export interface NormalizedMessage {
	uid: string;
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

export interface NormalizedSnapshot {
	source: "obar-chatgpt-webviewer";
	extractorVersion: string;
	conversationId?: string;
	conversationKey: string;
	conversationAliasKey: string;
	conversationTitle: string;
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
	conversationKey: string;
	filePath: string;
	sourceUrl: string;
	title?: string;
	createdAt: number;
	updatedAt: number;
	lastStableMessageCount: number;
	lastSnapshotHash: string;
	messages: SessionMessageIndex[];
}

export interface ConversationNoteEntry {
	filePath: string;
	conversationId?: string;
	conversationKey?: string;
	conversationAliasKey?: string;
	chatUrl?: string;
	title?: string;
	createdAt?: number;
	updatedAt?: number;
	messageCount?: number;
}

export interface PluginStateData {
	capturePaused: boolean;
}

export interface PersistedPluginSettingsData extends Partial<PluginSettings> {
	chatgptUrl?: string;
	saveFolder?: string;
}

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
	conversationKey: string;
	lastAssistantUid?: string;
	firstSeenAt?: number;
	lastHash?: string;
	stableRepeatCount: number;
}

export interface StabilityDecision {
	readyToPersist: boolean;
	reason: string;
	snapshot: NormalizedSnapshot;
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
	| "waiting-for-conversation-id"
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
	title?: string;
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
