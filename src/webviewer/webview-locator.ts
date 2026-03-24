import type { WorkspaceLeaf } from "obsidian";
import { isConfiguredChatUrl } from "../settings/chat-targets";
import type { ObarWebview, PluginSettings, WebviewBinding } from "../types";

interface LeafWithPrivateId extends WorkspaceLeaf {
	id?: string;
}

function isVisible(element: HTMLElement): boolean {
	const rect = element.getBoundingClientRect();
	const style = window.getComputedStyle(element);
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		style.visibility !== "hidden" &&
		style.display !== "none"
	);
}

export function getLeafId(leaf: WorkspaceLeaf): string {
	const privateId = (leaf as LeafWithPrivateId).id;
	if (privateId) {
		return privateId;
	}

	const state = leaf.getViewState() as {
		type?: string;
		state?: { url?: string };
	};
	return `${state.type ?? "leaf"}:${state.state?.url ?? "unknown"}`;
}

export function getLeafWebViewerUrl(leaf: WorkspaceLeaf): string | null {
	const state = leaf.getViewState() as {
		type?: string;
		state?: { url?: unknown };
	};

	if (state.type !== "webviewer") {
		return null;
	}

	const url = state.state?.url;
	return typeof url === "string" && url.length > 0 ? url : null;
}

export function safeGetWebviewUrl(webview: ObarWebview): string | null {
	try {
		if (typeof webview.getURL === "function") {
			const url = webview.getURL();
			if (url) {
				return url;
			}
		}
	} catch {
		// `getURL` can throw before the webview is ready.
	}

	return typeof webview.src === "string" && webview.src.length > 0 ? webview.src : null;
}

function belongsToLeaf(webview: ObarWebview, leaf: WorkspaceLeaf): boolean {
	const leafRoot =
		leaf.view.containerEl.closest(".workspace-leaf") ?? leaf.view.containerEl;
	const webviewRoot = webview.closest(".workspace-leaf") ?? webview.parentElement;
	return leafRoot === webviewRoot || leafRoot?.contains(webview) === true;
}

export class WebviewLocator {
	constructor(private readonly getSettings: () => PluginSettings) {}

	locateForLeaf(leaf: WorkspaceLeaf): WebviewBinding | null {
		const candidates = Array.from(document.querySelectorAll<ObarWebview>("webview"));
		const leafId = getLeafId(leaf);

		const ranked = candidates
			.map((webview) => {
				const url = safeGetWebviewUrl(webview);
				return {
					webview,
					url,
					score:
						(belongsToLeaf(webview, leaf) ? 4 : 0) +
						(isVisible(webview) ? 2 : 0) +
						(isConfiguredChatUrl(url, this.getSettings()) ? 1 : 0),
				};
			})
			.filter(
				(candidate) =>
					candidate.url && isConfiguredChatUrl(candidate.url, this.getSettings()),
			)
			.sort((left, right) => right.score - left.score);

		const top = ranked[0];
		if (!top?.url) {
			return null;
		}

		return {
			leafId,
			webview: top.webview,
			boundAt: Date.now(),
			lastUrl: top.url,
			status: "pending",
		};
	}
}
