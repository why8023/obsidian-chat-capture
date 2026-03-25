import { App, TFile, type WorkspaceLeaf } from "obsidian";

function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, delayMs);
	});
}

export class MarkdownNoteOpener {
	private leaf: WorkspaceLeaf | null = null;

	constructor(private readonly app: App) {}

	async open(file: TFile, options?: { focus?: boolean }): Promise<void> {
		const leaf = this.getOrCreateLeaf();
		await leaf.openFile(file, { active: true });
		await this.app.workspace.revealLeaf(leaf);
		this.app.workspace.setActiveLeaf(leaf, { focus: options?.focus ?? false });
		await sleep(75);
	}

	private getOrCreateLeaf(): WorkspaceLeaf {
		if (this.leaf && this.isReusableLeaf(this.leaf)) {
			return this.leaf;
		}

		this.leaf = this.app.workspace.getLeaf("tab");
		return this.leaf;
	}

	private isReusableLeaf(leaf: WorkspaceLeaf): boolean {
		return this.app.workspace.getLeavesOfType("markdown").includes(leaf);
	}
}
