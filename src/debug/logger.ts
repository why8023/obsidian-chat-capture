import { App, Modal } from "obsidian";
import type { LogEntry, LogLevel } from "../types";

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch (error) {
		return JSON.stringify(
			{
				serializationError:
					error instanceof Error ? error.message : String(error),
				value: String(value),
			},
			null,
			2,
		);
	}
}

function formatLogEntry(entry: LogEntry): string {
	const timestamp = new Date(entry.timestamp).toISOString();
	if (entry.context === undefined) {
		return `[${timestamp}] ${entry.level.toUpperCase()} ${entry.message}`;
	}

	const context =
		typeof entry.context === "string"
			? entry.context
			: safeStringify(entry.context);
	return `[${timestamp}] ${entry.level.toUpperCase()} ${entry.message}\n${context}`;
}

export class Logger {
	private readonly entries: LogEntry[] = [];

	constructor(private readonly maxEntries: number) {}

	debug(message: string, context?: unknown): void {
		this.write("debug", message, context);
	}

	info(message: string, context?: unknown): void {
		this.write("info", message, context);
	}

	warn(message: string, context?: unknown): void {
		this.write("warn", message, context);
	}

	error(message: string, context?: unknown): void {
		this.write("error", message, context);
	}

	getEntries(limit?: number): LogEntry[] {
		if (typeof limit !== "number" || limit <= 0) {
			return [...this.entries];
		}

		return this.entries.slice(-limit);
	}

	private write(level: LogLevel, message: string, context?: unknown): void {
		const entry: LogEntry = {
			level,
			message,
			context,
			timestamp: Date.now(),
		};

		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.shift();
		}

		const sink =
			level === "error"
				? console.error
				: level === "warn"
					? console.warn
					: level === "info"
						? console.debug
						: console.debug;
		sink(`[obsidian-chat-capture] ${message}`, context ?? "");
	}
}

export class CaptureLogModal extends Modal {
	constructor(app: App, private readonly entries: LogEntry[]) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("chat-capture-log-modal");
		contentEl.createEl("h2", { text: "Capture log" });
		const pre = contentEl.createEl("pre", { cls: "chat-capture-log-pre" });
		pre.setText(
			this.entries.length > 0
				? this.entries.map((entry) => formatLogEntry(entry)).join("\n\n")
				: "No capture logs yet.",
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
