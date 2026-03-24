import { EXTRACTOR_VERSION } from "../constants";
import { DEFAULT_SELECTOR_PROFILES } from "./selector-profiles";
import { buildPageProbeSource } from "./page-probe";
import { buildTurnShellCollectorSource } from "./turn-shell-collector";

export function buildDomExtractorSource(maxHtmlSnippetLength: number): string {
	const pageProbeSource = buildPageProbeSource();
	const turnShellCollectorSource = buildTurnShellCollectorSource();

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

${pageProbeSource
	.split("\n")
	.map((line) => `  ${line}`)
	.join("\n")}

${turnShellCollectorSource
	.split("\n")
	.map((line) => `  ${line}`)
	.join("\n")}

  function buildSnapshot(turns) {
    return {
      source: "chatgpt-webviewer",
      extractorVersion,
      pageUrl: location.href,
      pageTitle: document.title,
      capturedAt: new Date().toISOString(),
      conversationId: getConversationIdFromUrl(),
      conversationTitle: getDocumentConversationTitle(),
      pageState: detectPageState(turns),
      turns,
    };
  }

  function createRuntimeState() {
    return {
      dirty: true,
      pendingUpdate: false,
      observed: false,
      lastMutationAt: null,
      lastSnapshotAt: null,
      snapshot: null,
      observer: null,
      observerRoot: null,
      debounceTimer: null,
      idleHandle: null,
      listenersInstalled: false,
      lastUrl: location.href,
      lastTitle: document.title,
    };
  }

  const runtimeState =
    window.__OBSIDIAN_CHAT_CAPTURE_STATE__ &&
    typeof window.__OBSIDIAN_CHAT_CAPTURE_STATE__ === "object"
      ? window.__OBSIDIAN_CHAT_CAPTURE_STATE__
      : (window.__OBSIDIAN_CHAT_CAPTURE_STATE__ = createRuntimeState());

  function clearPendingRefresh() {
    if (runtimeState.debounceTimer !== null) {
      window.clearTimeout(runtimeState.debounceTimer);
      runtimeState.debounceTimer = null;
    }

    if (runtimeState.idleHandle !== null) {
      if (typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(runtimeState.idleHandle);
      } else {
        window.clearTimeout(runtimeState.idleHandle);
      }
      runtimeState.idleHandle = null;
    }
  }

  function queueSnapshotRefresh() {
    runtimeState.pendingUpdate = true;
    clearPendingRefresh();
    runtimeState.debounceTimer = window.setTimeout(() => {
      runtimeState.debounceTimer = null;
      const refresh = () => {
        runtimeState.pendingUpdate = false;
        runtimeState.idleHandle = null;
        updateSnapshot(true);
      };

      if (typeof window.requestIdleCallback === "function") {
        runtimeState.idleHandle = window.requestIdleCallback(refresh, { timeout: 500 });
      } else {
        runtimeState.idleHandle = window.setTimeout(refresh, 0);
      }
    }, 300);
  }

  function rememberLocation() {
    runtimeState.lastUrl = location.href;
    runtimeState.lastTitle = document.title;
  }

  function markDirty() {
    runtimeState.dirty = true;
    runtimeState.lastMutationAt = Date.now();
    rememberLocation();
    queueSnapshotRefresh();
  }

  function detectLocationChange() {
    if (
      runtimeState.lastUrl !== location.href ||
      runtimeState.lastTitle !== document.title
    ) {
      markDirty();
    }
  }

  function ensureObserver() {
    const nextRoot = document.body ?? document.documentElement;
    if (!nextRoot) {
      return;
    }

    if (!runtimeState.observer) {
      runtimeState.observer = new MutationObserver((mutations) => {
        if (!mutations.length) {
          return;
        }
        runtimeState.observed = true;
        markDirty();
      });
    }

    if (runtimeState.observerRoot === nextRoot) {
      return;
    }

    runtimeState.observer.disconnect();
    runtimeState.observer.observe(nextRoot, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "class",
        "data-message-author-role",
        "data-testid",
        "hidden",
        "style",
      ],
    });
    runtimeState.observerRoot = nextRoot;
    runtimeState.observed = true;
  }

  function installRuntimeListeners() {
    if (runtimeState.listenersInstalled) {
      return;
    }

    runtimeState.listenersInstalled = true;
    const onVisibilityChange = () => detectLocationChange();
    const onNavigationSignal = () => markDirty();

    document.addEventListener("visibilitychange", onVisibilityChange, true);
    window.addEventListener("focus", onNavigationSignal, true);
    window.addEventListener("pageshow", onNavigationSignal, true);
    window.addEventListener("popstate", onNavigationSignal, true);
    window.addEventListener("hashchange", onNavigationSignal, true);
  }

  function updateSnapshot(forceRefresh) {
    ensureObserver();
    detectLocationChange();

    if (!forceRefresh && !runtimeState.dirty && runtimeState.snapshot) {
      return runtimeState.snapshot;
    }

    const turns = collectTurns();
    const snapshot = buildSnapshot(turns);
    runtimeState.snapshot = snapshot;
    runtimeState.dirty = false;
    runtimeState.pendingUpdate = false;
    runtimeState.lastSnapshotAt = Date.now();
    rememberLocation();
    return snapshot;
  }

  function getDiagnostics() {
    ensureObserver();
    detectLocationChange();
    const snapshot =
      runtimeState.snapshot &&
      runtimeState.snapshot.pageUrl === location.href &&
      runtimeState.snapshot.pageTitle === document.title
        ? runtimeState.snapshot
        : null;

    return {
      pageState: snapshot?.pageState ?? detectPageState([]),
      messageCount: Array.isArray(snapshot?.turns) ? snapshot.turns.length : null,
      dirty: Boolean(runtimeState.dirty || !snapshot),
      pendingUpdate: Boolean(runtimeState.pendingUpdate),
      observed: Boolean(runtimeState.observed),
      visibilityState: typeof document.visibilityState === "string"
        ? document.visibilityState
        : null,
      lastMutationAt:
        typeof runtimeState.lastMutationAt === "number" ? runtimeState.lastMutationAt : null,
      lastSnapshotAt:
        typeof runtimeState.lastSnapshotAt === "number" ? runtimeState.lastSnapshotAt : null,
    };
  }

  installRuntimeListeners();
  ensureObserver();
  if (!runtimeState.snapshot) {
    queueSnapshotRefresh();
  }

  return {
    getDiagnostics() {
      return getDiagnostics();
    },
    health() {
      return {
        ok: true,
        url: location.href,
        title: document.title,
        ...getDiagnostics(),
      };
    },
    collect() {
      return updateSnapshot(false);
    },
  };
})()
`.trim();
}
