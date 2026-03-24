import { EXTRACTOR_VERSION } from "../constants";
import { DEFAULT_SELECTOR_PROFILES } from "./selector-profiles";

export function buildDomExtractorSource(maxHtmlSnippetLength: number): string {
	return `
(() => {
  const extractorVersion = ${JSON.stringify(EXTRACTOR_VERSION)};
  const maxHtmlSnippetLength = ${Math.max(200, maxHtmlSnippetLength)};
  const profiles = ${JSON.stringify(DEFAULT_SELECTOR_PROFILES)};

  function normalizeText(input) {
    return String(input ?? "")
      .replace(/\\r\\n/g, "\\n")
      .replace(/[\\u200B-\\u200D\\uFEFF]/g, "")
      .replace(/\\u00A0/g, " ")
      .replace(/[ \\t]+\\n/g, "\\n")
      .replace(/\\n{3,}/g, "\\n\\n")
      .trim();
  }

  function hashString(input) {
    let hash = 2166136261;
    const value = String(input ?? "");
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash +=
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function queryAllUnique(root, selectors) {
    const seen = new Set();
    const elements = [];
    for (const selector of selectors) {
      try {
        for (const element of root.querySelectorAll(selector)) {
          if (!seen.has(element)) {
            seen.add(element);
            elements.push(element);
          }
        }
      } catch (error) {
        // Ignore invalid selectors so fallback selectors still run.
      }
    }
    return elements;
  }

  function getNodeDepth(element) {
    let depth = 0;
    let current = element;
    while (current.parentElement) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function sortByDocumentOrder(elements) {
    return [...elements].sort((left, right) => {
      if (left === right) {
        return 0;
      }
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    });
  }

  function pruneNestedCandidates(elements) {
    const kept = [];
    const byDepth = [...elements].sort(
      (left, right) => getNodeDepth(right) - getNodeDepth(left),
    );
    for (const candidate of byDepth) {
      if (kept.some((existing) => candidate.contains(existing))) {
        continue;
      }
      kept.push(candidate);
    }
    return sortByDocumentOrder(kept);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function findMainContainer() {
    for (const profile of profiles) {
      for (const selector of profile.mainCandidates) {
        try {
          const element = document.querySelector(selector);
          if (element) {
            return element;
          }
        } catch (error) {
          // Keep scanning fallback selectors.
        }
      }
    }
    return document.body;
  }

  function stripUiNodes(element) {
    const clone = element.cloneNode(true);
    for (const profile of profiles) {
      for (const selector of profile.ignoreSelectors) {
        try {
          clone.querySelectorAll(selector).forEach((node) => node.remove());
        } catch (error) {
          // Keep the clone even if a selector fails.
        }
      }
    }
    clone.querySelectorAll("pre button, pre [role='button']").forEach((node) => node.remove());
    return clone;
  }

  function detectRole(element) {
    const directRole = element.getAttribute("data-message-author-role");
    if (directRole === "user" || directRole === "assistant" || directRole === "system") {
      return directRole;
    }

    const descendantRole = element
      .querySelector("[data-message-author-role]")
      ?.getAttribute("data-message-author-role");
    if (
      descendantRole === "user" ||
      descendantRole === "assistant" ||
      descendantRole === "system"
    ) {
      return descendantRole;
    }

    const haystack = [
      element.getAttribute("aria-label"),
      element.getAttribute("data-testid"),
      element.className,
      element.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const [profile] = profiles;
    if (profile.userRoleHints.some((hint) => haystack.includes(hint))) {
      return "user";
    }
    if (profile.assistantRoleHints.some((hint) => haystack.includes(hint))) {
      return "assistant";
    }
    if (profile.systemRoleHints.some((hint) => haystack.includes(hint))) {
      return "system";
    }
    return "unknown";
  }

  function parseNarrationText(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return null;
    }

    const patterns = [
      {
        kind: "user-echo",
        regex: /^(?:you|user)\s*(?:said|asked)\s*[:\uFF1A]\s*/i,
      },
      {
        kind: "user-echo",
        regex: /^(?:\u4f60|\u60a8)\s*(?:\u8bf4|\u95ee)\s*[:\uFF1A]\s*/,
      },
      {
        kind: "assistant-echo",
        regex:
          /^(?:chatgpt|assistant|gpt|model|\u52a9\u624b|\u6a21\u578b)\s*(?:said|says|\u8bf4)?\s*[:\uFF1A]\s*/i,
      },
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern.regex);
      if (!match) {
        continue;
      }

      return {
        kind: pattern.kind,
        content: normalizeText(normalized.slice(match[0].length)),
      };
    }

    return null;
  }

  function isTransientAssistantStatus(text) {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
      return false;
    }

    return [
      /^thinking$/,
      /^thought for \d+s$/,
      /^reasoned for .+$/,
      /^searching$/,
      /^searching the web$/,
      /^\u6b63\u5728\u601d\u8003(?:\u4e2d)?$/,
      /^\u601d\u8003\u4e2d$/,
      /^\u6b63\u5728\u5206\u6790$/,
      /^\u641c\u7d22\u4e2d$/,
    ].some((pattern) => pattern.test(normalized));
  }

  function shouldDropNarrationMessage(message, messages) {
    const narration = parseNarrationText(message.text);
    if (!narration) {
      return false;
    }

    if (narration.kind === "user-echo") {
      return true;
    }

    if (!narration.content || isTransientAssistantStatus(narration.content)) {
      return true;
    }

    return messages.some((other) => {
      if (other === message || other.role !== "assistant") {
        return false;
      }

      const otherText = normalizeText(other.text);
      if (!otherText) {
        return false;
      }

      return (
        narration.content === otherText ||
        narration.content.startsWith(otherText) ||
        otherText.startsWith(narration.content)
      );
    });
  }

  function extractCodeBlocks(element) {
    const blocks = [];
    element.querySelectorAll("pre").forEach((pre) => {
      const codeElement = pre.querySelector("code") ?? pre;
      const code = codeElement.innerText ?? codeElement.textContent ?? "";
      const className = codeElement.className ?? pre.className ?? "";
      const languageMatch = String(className).match(/language-([\\w-]+)/i);
      const dataLanguage =
        codeElement.getAttribute("data-language") ?? pre.getAttribute("data-language") ?? undefined;

      const normalizedCode = normalizeText(code.replace(/^(Copy code|Copy)\\s*/i, ""));
      if (!normalizedCode) {
        return;
      }

      blocks.push({
        language: dataLanguage ?? languageMatch?.[1],
        code: normalizedCode,
      });
    });
    return blocks;
  }

  function renderMarkdownApprox(element) {
    const clone = stripUiNodes(element);
    clone.querySelectorAll("pre").forEach((node) => node.remove());

    const lines = [];
    clone.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = normalizeText(node.textContent);
        if (text) {
          lines.push(text);
        }
        return;
      }

      if (!(node instanceof HTMLElement)) {
        return;
      }

      const tag = node.tagName.toLowerCase();
      const text = normalizeText(node.innerText || node.textContent || "");
      if (!text) {
        return;
      }

      if (tag === "li") {
        lines.push("- " + text);
      } else if (/^h[1-6]$/.test(tag)) {
        const level = Number.parseInt(tag.slice(1), 10);
        lines.push("#".repeat(Math.max(1, Math.min(level, 6))) + " " + text);
      } else if (tag === "blockquote") {
        lines.push("> " + text.replace(/\\n/g, "\\n> "));
      } else {
        lines.push(text);
      }
    });

    return normalizeText(lines.join("\\n\\n"));
  }

  function extractText(element) {
    const clone = stripUiNodes(element);
    clone.querySelectorAll("pre").forEach((node) => node.remove());
    return normalizeText(clone.innerText || clone.textContent || "");
  }

  function hasCompletionActions(element) {
    const selectors = [
      "[data-testid='copy-turn-action-button']",
      "[data-testid='good-response-turn-action-button']",
      "[data-testid='bad-response-turn-action-button']",
    ];

    return selectors.some((selector) => {
      try {
        return Boolean(element.querySelector(selector));
      } catch (error) {
        return false;
      }
    });
  }

  function getDocumentConversationTitle() {
    const normalized = normalizeText(document.title.replace(/\\s+-\\s+ChatGPT$/i, ""));
    if (!normalized || /^chatgpt$/i.test(normalized)) {
      return "";
    }
    return normalized;
  }

  function getConversationTitle(messages) {
    const title = getDocumentConversationTitle();
    if (title) {
      return title;
    }

    const firstUser = messages.find((message) => message.role === "user");
    return normalizeText(firstUser?.text ?? "").slice(0, 80) || "Untitled conversation";
  }

  function getConversationIdFromUrl() {
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/i);
    return normalizeText(match?.[1] ?? "");
  }

  function buildConversationKey(messages) {
    const conversationId = getConversationIdFromUrl();
    if (conversationId) {
      return hashString("conversation-id|" + conversationId);
    }

    const firstUser = normalizeText(
      messages.find((message) => message.role === "user")?.text ?? "",
    ).slice(0, 200);
    return hashString([
      location.pathname + location.search,
      getConversationTitle(messages),
      firstUser,
    ].join("|"));
  }

  function detectPageState(messages) {
    if (
      document.querySelector("input[type='password']") ||
      /login|auth|signin/i.test(location.pathname)
    ) {
      return "login";
    }
    if (messages.length > 0) {
      return "conversation";
    }
    if (document.querySelector("nav a[href*='/c/']")) {
      return "chat-list";
    }
    return "unknown";
  }

  function collectMessages() {
    const main = findMainContainer();
    const selectors = profiles.flatMap((profile) => profile.messageCandidates);
    const candidates = pruneNestedCandidates(
      queryAllUnique(main, selectors).filter((element) => isVisible(element)),
    );

    const messages = [];
    for (const candidate of candidates) {
      const role = detectRole(candidate);
      const text = extractText(candidate);
      const codeBlocks = extractCodeBlocks(candidate);

      if (!text && codeBlocks.length === 0) {
        continue;
      }

      const markdownApprox = renderMarkdownApprox(candidate);
      messages.push({
        ordinal: messages.length + 1,
        role,
        text,
        markdownApprox,
        codeBlocks,
        rawHtmlSnippet: String(candidate.innerHTML ?? "").slice(0, maxHtmlSnippetLength),
        nodeFingerprint: hashString([role, text, JSON.stringify(codeBlocks)].join("|")),
        hasCompletionActions: role === "assistant" ? hasCompletionActions(candidate) : false,
      });
    }

    return messages
      .filter((message) => !shouldDropNarrationMessage(message, messages))
      .map((message, index) => ({
        ...message,
        ordinal: index + 1,
      }));
  }

  return {
    health() {
      const messages = collectMessages();
      return {
        ok: true,
        url: location.href,
        title: document.title,
        pageState: detectPageState(messages),
        messageCount: messages.length,
      };
    },
    collect() {
      const messages = collectMessages();
      return {
        source: "chatgpt-webviewer",
        extractorVersion,
        pageUrl: location.href,
        pageTitle: document.title,
        capturedAt: new Date().toISOString(),
        conversationKey: buildConversationKey(messages),
        conversationTitle: getConversationTitle(messages),
        pageState: detectPageState(messages),
        messages,
      };
    },
  };
})()
`.trim();
}
