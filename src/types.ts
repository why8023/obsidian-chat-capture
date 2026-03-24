export type ChatMessageRole = "user" | "assistant" | "system" | "unknown";
export type PageState = "login" | "chat-list" | "conversation" | "unknown";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type RuntimeState =
	| "idle"
	| "openingViewer"
	| "bindingWebview"
	| "injecting"
	| "polling"
	| "saving"
	| "backoff"
	| "error";

export interface PluginSettings {
	chatgptUrl: string;
	saveFolder: string;
	fileNameTemplate: string;
	pollIntervalMs: number;
	settleRepeatCount: number;
	settleTimeoutMs: number;
	autoCapture: boolean;
	saveRawSnapshot: boolean;
	maxHtmlSnippetLength: number;
	debugMode: boolean;
}

export interface ControlledViewerRef {
	leafId: string;
	expectedUrlPrefix: string;
	createdAt: number;
	lastSeenAt: number;
}

export interface CodeBlock {
	language?: string;
	code: string;
}

export interface ChatMessageSnapshot {
	ordinal: number;
	role: ChatMessageRole;
	text: string;
	markdownApprox?: string;
	codeBlocks?: CodeBlock[];
	rawHtmlSnippet?: string;
	nodeFingerprint?: string;
}

export interface ConversationSnapshot {
	source: "chatgpt-webviewer";
	extractorVersion: string;
	pageUrl: string;
	pageTitle: string;
	capturedAt: string;
	conversationKey?: string;
	conversationTitle?: string;
	pageState: PageState;
	messages: ChatMessageSnapshot[];
}

export interface NormalizedMessage {
	uid: string;
	ordinal: number;
	role: ChatMessageRole;
	text: string;
	textHash: string;
	codeBlocks: CodeBlock[];
	rawHtmlSnippet?: string;
	nodeFingerprint?: string;
}

export interface NormalizedSnapshot {
	source: "chatgpt-webviewer";
	extractorVersion: string;
	conversationKey: string;
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

export interface PluginStateData {
	version: string;
	controlledViewer?: ControlledViewerRef;
	sessions: Record<string, SessionIndexEntry>;
	capturePaused: boolean;
}

export interface PersistedPluginData {
	settings?: Partial<PluginSettings>;
	state?: Partial<PluginStateData>;
}

export interface ChatCaptureWebview extends HTMLElement {
	executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
	getURL?(): string;
	src?: string;
}

export interface WebviewBinding {
	leafId: string;
	webview: ChatCaptureWebview;
	boundAt: number;
	lastUrl: string;
	status: "pending" | "ready" | "lost";
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

export interface CaptureDiagnostics {
	pageUrl: string | null;
	pageTitle: string;
	readyState: string;
	pageState?: PageState | null;
	hasCaptureApi: boolean;
	captureVersion: string | null;
	messageCount?: number | null;
}

export interface SerializedError {
	message: string;
	name?: string;
	stack?: string;
}

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
