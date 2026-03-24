import type { LogEntry, LogLevel } from "../types";

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
		sink(`[OBAR] ${message}`, context ?? "");
	}
}
