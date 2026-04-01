export function buildTurnShellCollectorSource(): string {
	return `
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

  function extractTextHint(element) {
    const clone = stripUiNodes(element);
    return normalizeText(clone.textContent || "");
  }

  function buildDomPath(element) {
    const segments = [];
    let current = element;
    while (
      current &&
      current !== document.body &&
      current !== document.documentElement
    ) {
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (sibling) => sibling.tagName === current.tagName,
          )
        : [current];
      const index = Math.max(0, siblings.indexOf(current)) + 1;
      const testId = current.getAttribute("data-testid");
      const role = current.getAttribute("data-message-author-role");
      const id = current.id;
      segments.unshift(
        [
          current.tagName.toLowerCase(),
          id ? "#" + id : "",
          testId ? "[" + testId + "]" : "",
          role ? "(" + role + ")" : "",
          ":" + index,
        ].join(""),
      );
      current = current.parentElement;
    }
    return segments.join(">");
  }

  function buildDomKey(candidate, contentRoot, role) {
    const tokens = [role];
    for (const element of [candidate, contentRoot]) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      tokens.push(
        [
          element.getAttribute("data-message-author-role"),
          element.getAttribute("data-testid"),
          element.getAttribute("aria-label"),
          element.id,
          buildDomPath(element),
        ]
          .filter(Boolean)
          .join("|"),
      );
    }
    return hashString(tokens.join("||"));
  }

  function findTurnRoot(candidate) {
    const selectors = [
      "section[data-testid*='conversation-turn']",
      "section[id^='conversation-turn']",
      "article[data-testid*='conversation-turn']",
      "article[id^='conversation-turn']",
    ];
    for (const selector of selectors) {
      try {
        const match = candidate.closest(selector);
        if (match instanceof HTMLElement) {
          return match;
        }
      } catch (error) {
        // Keep scanning fallback selectors.
      }
    }
    return candidate;
  }

  function findContentRoot(candidate, turnRoot) {
    const selectors = profiles.flatMap((profile) => profile.contentRootCandidates);
    const roots = candidate === turnRoot ? [candidate] : [candidate, turnRoot];
    for (const root of roots) {
      for (const selector of selectors) {
        try {
          const match = root.matches(selector)
            ? root
            : root.querySelector(selector);
          if (!(match instanceof HTMLElement)) {
            continue;
          }

          const html = String(match.innerHTML ?? "").trim();
          const text = normalizeText(match.textContent || "");
          if (html || text) {
            return match;
          }
        } catch (error) {
          // Keep scanning fallbacks.
        }
      }
    }

    return turnRoot;
  }

  function extractActionFlags(element) {
    const hasAny = (selectors) =>
      selectors.some((selector) => {
        try {
          return Boolean(element.querySelector(selector));
        } catch (error) {
          return false;
        }
      });

    return {
      hasCopyButton: hasAny([
        "[data-testid='copy-turn-action-button']",
        "[data-testid='copy-code-button']",
      ]),
      hasThumbActions: hasAny([
        "[data-testid='good-response-turn-action-button']",
        "[data-testid='bad-response-turn-action-button']",
      ]),
    };
  }

  function detectRole(element) {
    const directRole = element.getAttribute("data-message-author-role");
    if (directRole === "user" || directRole === "system" || directRole === "ai") {
      return directRole;
    }
    if (directRole === "assistant") {
      return "ai";
    }

    const descendantRole = element
      .querySelector("[data-message-author-role]")
      ?.getAttribute("data-message-author-role");
    if (
      descendantRole === "user" ||
      descendantRole === "system" ||
      descendantRole === "ai"
    ) {
      return descendantRole;
    }
    if (descendantRole === "assistant") {
      return "ai";
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
    if (profile.aiRoleHints.some((hint) => haystack.includes(hint))) {
      return "ai";
    }
    if (profile.systemRoleHints.some((hint) => haystack.includes(hint))) {
      return "system";
    }
    return "unknown";
  }

  function detectTurnRole(candidate, turnRoot) {
    const directRole = detectRole(candidate);
    if (directRole !== "unknown") {
      return directRole;
    }
    return detectRole(turnRoot);
  }

  function parseNarrationText(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return null;
    }

    const patterns = [
      {
        kind: "user-echo",
        regex: /^(?:you|user)\\s*(?:said|asked)\\s*[:\\uFF1A]\\s*/i,
      },
      {
        kind: "user-echo",
        regex: /^(?:\\u4f60|\\u60a8)\\s*(?:\\u8bf4|\\u95ee)\\s*[:\\uFF1A]\\s*/,
      },
      {
        kind: "ai-echo",
        regex:
          /^(?:chatgpt|assistant|gpt|model|\\u52a9\\u624b|\\u6a21\\u578b)\\s*(?:said|says|\\u8bf4)?\\s*[:\\uFF1A]\\s*/i,
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

  function isTransientAiStatus(text) {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) {
      return false;
    }

    return [
      /^thinking$/,
      /^thought for \\d+s$/,
      /^reasoned for .+$/,
      /^searching$/,
      /^searching the web$/,
      /^\\u6b63\\u5728\\u601d\\u8003(?:\\u4e2d)?$/,
      /^\\u601d\\u8003\\u4e2d$/,
      /^\\u6b63\\u5728\\u5206\\u6790$/,
      /^\\u641c\\u7d22\\u4e2d$/,
    ].some((pattern) => pattern.test(normalized));
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function summarizeEmbeddedFrame(iframe) {
    const title = normalizeText(iframe.getAttribute("title"));
    if (title && !/^internal:\\/\\//i.test(title)) {
      return title;
    }

    const src = normalizeText(iframe.getAttribute("src"));
    if (!src) {
      return title || "embedded frame";
    }

    try {
      const url = new URL(src, location.href);
      return url.hostname || src;
    } catch (error) {
      return src;
    }
  }

  function findUnavailableEmbeddedFrame(turnRoot) {
    const iframes = Array.from(turnRoot.querySelectorAll("iframe"));
    for (const iframe of iframes) {
      const src = normalizeText(iframe.getAttribute("src"));
      let unavailable = false;
      if (src) {
        try {
          unavailable = new URL(src, location.href).origin !== location.origin;
        } catch (error) {
          unavailable = true;
        }
      }

      if (!unavailable) {
        try {
          unavailable = !iframe.contentDocument;
        } catch (error) {
          unavailable = true;
        }
      }

      if (unavailable) {
        return iframe;
      }
    }

    return null;
  }

  function buildPartialAssistantFallback(turnRoot, contentTextHint) {
    const unavailableFrame = findUnavailableEmbeddedFrame(turnRoot);
    if (!unavailableFrame) {
      return null;
    }

    const narration = parseNarrationText(contentTextHint);
    if (narration?.kind !== "ai-echo" || narration.content) {
      return null;
    }

    const frameLabel = summarizeEmbeddedFrame(unavailableFrame);
    const notice =
      "OBAR note: This assistant reply is rendered inside an embedded frame (" +
      frameLabel +
      ") and could not be captured. The available user messages were saved as a partial record.";
    return {
      captureState: "partial",
      captureNotice: notice,
      contentTextHint: notice,
      contentHtml:
        "<p><strong>OBAR note:</strong> " +
        escapeHtml(
          "This assistant reply is rendered inside an embedded frame (" +
            frameLabel +
            ") and could not be captured. The available user messages were saved as a partial record.",
        ) +
        "</p>",
    };
  }

  function shouldDropShell(shell, shells) {
    if (shell.captureState === "partial") {
      return false;
    }

    const narration = parseNarrationText(shell.contentTextHint);
    if (!narration) {
      return false;
    }

    if (narration.kind === "user-echo") {
      return true;
    }

    if (!narration.content || isTransientAiStatus(narration.content)) {
      return true;
    }

    return shells.some((other) => {
      if (other === shell || other.role !== "ai") {
        return false;
      }

      const otherText = normalizeText(other.contentTextHint);
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

  function collectTurns() {
    const main = findMainContainer();
    const selectors = profiles.flatMap((profile) => profile.messageCandidates);
    const candidates = pruneNestedCandidates(
      queryAllUnique(main, selectors).filter((element) => isVisible(element)),
    );

    const turns = [];
    for (const candidate of candidates) {
      const turnRoot = findTurnRoot(candidate);
      const role = detectTurnRole(candidate, turnRoot);
      const contentRoot = findContentRoot(candidate, turnRoot);
      const partialAssistantFallback =
        role === "ai"
          ? buildPartialAssistantFallback(turnRoot, extractTextHint(contentRoot))
          : null;
      const sanitizedRoot = stripUiNodes(contentRoot);
      const contentHtml =
        partialAssistantFallback?.contentHtml ??
        String(sanitizedRoot.innerHTML ?? "").trim();
      const contentTextHint =
        partialAssistantFallback?.contentTextHint ?? extractTextHint(contentRoot);
      if (!contentHtml && !contentTextHint) {
        continue;
      }

      const actionFlags =
        role === "ai"
          ? extractActionFlags(turnRoot)
          : {
              hasCopyButton: false,
              hasThumbActions: false,
            };

        turns.push({
          ordinal: turns.length + 1,
          role,
          domKey: buildDomKey(turnRoot, contentRoot, role),
          contentHtml,
          contentHtmlHash: hashString(contentHtml),
          contentTextHint,
          rawHtmlSnippet: contentHtml.slice(0, maxHtmlSnippetLength),
          actionFlags,
          captureState: partialAssistantFallback?.captureState,
          captureNotice: partialAssistantFallback?.captureNotice,
        });
      }

    return turns
      .filter((shell) => !shouldDropShell(shell, turns))
      .map((shell, index) => ({
        ...shell,
        ordinal: index + 1,
      }));
  }
`.trim();
}
