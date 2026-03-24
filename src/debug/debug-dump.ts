import { normalizePath, type App, type PluginManifest } from "obsidian";
import { Logger } from "./logger";

export class DebugDumpWriter {
	constructor(
		private readonly app: App,
		private readonly manifest: PluginManifest,
		private readonly isEnabled: () => boolean,
		private readonly logger: Logger,
	) {}

	async writeSnapshot(name: string, payload: unknown): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		await this.writeJson(`${name}.json`, payload);
	}

	async writeRuntimeState(payload: unknown): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		await this.writeJson("runtime-state.json", payload);
	}

	private async writeJson(fileName: string, payload: unknown): Promise<void> {
		try {
			const debugDir = await this.ensureDebugDir();
			const path = normalizePath(`${debugDir}/${fileName}`);
			await this.app.vault.adapter.write(path, JSON.stringify(payload, null, 2));
		} catch (error) {
			this.logger.warn("Failed to write debug dump", {
				fileName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async ensureDebugDir(): Promise<string> {
		const pluginDir = this.resolvePluginDir();
		const debugDir = normalizePath(`${pluginDir}/debug`);
		const adapter = this.app.vault.adapter;

		if (!(await adapter.exists(pluginDir))) {
			await adapter.mkdir(pluginDir);
		}
		if (!(await adapter.exists(debugDir))) {
			await adapter.mkdir(debugDir);
		}

		return debugDir;
	}

	private resolvePluginDir(): string {
		if (this.manifest.dir) {
			return normalizePath(this.manifest.dir);
		}

		return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
	}
}
