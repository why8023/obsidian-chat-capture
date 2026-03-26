export function buildPageProbeSource(): string {
	return `
  function getDocumentSessionTitle() {
    const normalized = normalizeText(document.title.replace(/\\s+-\\s+ChatGPT$/i, ""));
    if (!normalized || /^chatgpt$/i.test(normalized)) {
      return "";
    }
    return normalized;
  }

  function getSessionIdFromUrl() {
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/i);
    return normalizeText(match?.[1] ?? "");
  }

  function detectPageState(turns) {
    if (
      document.querySelector("input[type='password']") ||
      /login|auth|signin/i.test(location.pathname)
    ) {
      return "login";
    }
    if (turns.length > 0) {
      return "session";
    }
    if (document.querySelector("nav a[href*='/c/']")) {
      return "chat-list";
    }
    return "unknown";
  }
`.trim();
}
