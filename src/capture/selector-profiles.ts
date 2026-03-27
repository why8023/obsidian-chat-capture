export interface SelectorProfileDefinition {
	id: string;
	description: string;
	mainCandidates: string[];
	messageCandidates: string[];
	contentRootCandidates: string[];
	userRoleHints: string[];
	aiRoleHints: string[];
	systemRoleHints: string[];
	ignoreSelectors: string[];
}

export const DEFAULT_SELECTOR_PROFILES: SelectorProfileDefinition[] = [
	{
		id: "chatgpt-web-basic",
		description: "Baseline selectors for ChatGPT Web Viewer capture.",
		mainCandidates: [
			"main",
			"[role='main']",
			"div[role='presentation'] main",
		],
		messageCandidates: [
			"[data-message-author-role]",
			"article[data-testid*='conversation-turn']",
			"main article",
			"main [data-testid^='conversation-turn']",
		],
		contentRootCandidates: [
			"[data-testid='conversation-turn-content']",
			"[data-testid='conversation-turn-content'] .markdown",
			"[data-testid='conversation-turn-content'] .prose",
			".markdown",
			".prose",
			"[dir='auto']",
		],
		userRoleHints: ["user", "you"],
		aiRoleHints: ["assistant", "chatgpt", "gpt", "model", "ai"],
		systemRoleHints: ["system"],
		ignoreSelectors: [
			"button",
			"svg",
			"style",
			"script",
			"noscript",
			"textarea",
			"[aria-hidden='true']",
		],
	},
];
