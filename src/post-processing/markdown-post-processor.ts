import { App, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import {
	getCommandManager,
	getObsidianCommand,
	type CommandManagerLike,
} from "../commands/command-registry";
import { formatObarUiText } from "../constants";
import { Logger } from "../debug/logger";
import type { PluginSettings } from "../types";

function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, delayMs);
	});
}

export class MarkdownPostProcessor {
	private commandLeaf: WorkspaceLeaf | null = null;
	private lastWarningKey: string | null = null;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => PluginSettings,
		private readonly logger: Logger,
	) {}

	async run(file: TFile): Promise<void> {
		const settings = this.getSettings().postProcessing;
		if (!settings.enabled || settings.commandIds.length === 0) {
			return;
		}

		try {
			const manager = this.getCommandManager();
			if (!manager?.executeCommandById) {
				this.logger.warn("Post-processing command manager unavailable", {
					filePath: file.path,
				});
				this.warnOnce(
					"command-manager-unavailable",
					"Post-processing is unavailable because Obsidian commands could not be accessed.",
				);
				return;
			}

			if (settings.openNote) {
				await this.prepareFileForCommands(file);
			}

			let allSucceeded = true;
			for (const commandId of settings.commandIds) {
				const succeeded = await this.runCommand(manager, commandId, file);
				allSucceeded = allSucceeded && succeeded;
			}

			if (allSucceeded) {
				this.lastWarningKey = null;
			}
		} catch (error) {
			this.logger.error("Post-processing failed before command execution", {
				filePath: file.path,
				error: this.serializeError(error),
			});
			this.warnOnce(
				"post-processing-bootstrap-failed",
				`Post-processing failed for ${file.path}. Check the console for details.`,
			);
		}
	}

	private async runCommand(
		manager: CommandManagerLike,
		commandId: string,
		file: TFile,
	): Promise<boolean> {
		if (!this.hasCommand(manager, commandId)) {
			this.logger.warn("Post-processing command not found", {
				filePath: file.path,
				commandId,
			});
			this.warnOnce(
				`missing:${commandId}`,
				`Post-processing skipped missing command: ${commandId}`,
			);
			return false;
		}

		try {
			const executed = await manager.executeCommandById?.(commandId);
			if (executed === false) {
				this.logger.warn("Post-processing command declined execution", {
					filePath: file.path,
					commandId,
				});
				this.warnOnce(
					`declined:${commandId}`,
					`Post-processing command could not run: ${commandId}`,
				);
				return false;
			}

			this.logger.info("Post-processing command executed", {
				filePath: file.path,
				commandId,
			});
			return true;
		} catch (error) {
			this.logger.error("Post-processing command failed", {
				filePath: file.path,
				commandId,
				error: this.serializeError(error),
			});
			this.warnOnce(
				`failed:${commandId}`,
				`Post-processing command failed: ${commandId}`,
			);
			return false;
		}
	}

	private async prepareFileForCommands(file: TFile): Promise<void> {
		const leaf = this.getOrCreateCommandLeaf();
		await leaf.openFile(file, { active: true });
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: false });
		await sleep(75);
	}

	private getOrCreateCommandLeaf(): WorkspaceLeaf {
		if (this.commandLeaf && this.isReusableCommandLeaf(this.commandLeaf)) {
			return this.commandLeaf;
		}

		this.commandLeaf = this.app.workspace.getLeaf("tab");
		return this.commandLeaf;
	}

	private isReusableCommandLeaf(leaf: WorkspaceLeaf): boolean {
		return this.app.workspace.getLeavesOfType("markdown").includes(leaf);
	}

	private getCommandManager(): CommandManagerLike | undefined {
		return getCommandManager(this.app);
	}

	private hasCommand(manager: CommandManagerLike, commandId: string): boolean {
		return !manager.commands || getObsidianCommand(this.app, commandId) !== null;
	}

	private warnOnce(key: string, message: string): void {
		if (this.lastWarningKey === key) {
			return;
		}

		this.lastWarningKey = key;
		new Notice(formatObarUiText(message), 6_000);
	}

	private serializeError(error: unknown): {
		message: string;
		name?: string;
		stack?: string;
	} {
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
}
