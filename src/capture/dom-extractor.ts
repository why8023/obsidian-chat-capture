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

  function getConversationTitle(messages) {
    const title = normalizeText(document.title.replace(/\\s+-\\s+ChatGPT$/i, ""));
    if (title) {
      return title;
    }

    const firstUser = messages.find((message) => message.role === "user");
    return normalizeText(firstUser?.text ?? "").slice(0, 80) || "Untitled conversation";
  }

  function buildConversationKey(messages) {
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
    const candidates = queryAllUnique(main, selectors).filter((element) => isVisible(element));

    const messages = [];
    let ordinal = 1;
    for (const candidate of candidates) {
      const role = detectRole(candidate);
      const text = extractText(candidate);
      const codeBlocks = extractCodeBlocks(candidate);

      if (!text && codeBlocks.length === 0) {
        continue;
      }

      const markdownApprox = renderMarkdownApprox(candidate);
      messages.push({
        ordinal,
        role,
        text,
        markdownApprox,
        codeBlocks,
        rawHtmlSnippet: String(candidate.innerHTML ?? "").slice(0, maxHtmlSnippetLength),
        nodeFingerprint: hashString([role, text, JSON.stringify(codeBlocks)].join("|")),
        hasCompletionActions: role === "assistant" ? hasCompletionActions(candidate) : false,
      });
      ordinal += 1;
    }

    return messages;
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
