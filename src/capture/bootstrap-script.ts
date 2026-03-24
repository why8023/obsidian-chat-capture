import { EXTRACTOR_VERSION } from "../constants";
import type { CaptureHealth } from "../types";
import { buildDomExtractorSource } from "./dom-extractor";

function createWrappedScript(stage: string, body: string): string {
	return `
(() => {
  const stage = ${JSON.stringify(stage)};
  const getApi = () => window.__obsidianChatCapture__;
  const buildDiagnostics = (overrides = {}) => {
    const currentApi = getApi();
    let runtimeDiagnostics = {};
    try {
      runtimeDiagnostics =
        typeof currentApi?.getDiagnostics === "function"
          ? currentApi.getDiagnostics()
          : {};
    } catch (error) {
      runtimeDiagnostics = {
        diagnosticsError:
          error && typeof error === "object" && typeof error.message === "string"
            ? error.message
            : String(error),
      };
    }
    return {
      pageUrl: typeof location?.href === "string" ? location.href : null,
      pageTitle: typeof document?.title === "string" ? document.title : "",
      readyState: typeof document?.readyState === "string" ? document.readyState : "unknown",
      hasCaptureApi: Boolean(currentApi),
      captureVersion: typeof currentApi?.version === "string" ? currentApi.version : null,
      ...runtimeDiagnostics,
      ...overrides,
    };
  };
  const serializeError = (error) => {
    if (error && typeof error === "object") {
      return {
        name: typeof error.name === "string" ? error.name : undefined,
        message: typeof error.message === "string" ? error.message : String(error),
        stack: typeof error.stack === "string" ? error.stack : undefined,
      };
    }
    return { message: String(error) };
  };

  try {
${body
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
  } catch (error) {
    return {
      ok: false,
      stage,
      error: serializeError(error),
      diagnostics: buildDiagnostics(),
    };
  }
})()
`.trim();
}

export const HEALTHCHECK_SCRIPT = createWrappedScript(
	"healthcheck",
	`
const api = getApi();
if (!api || typeof api.health !== "function") {
  return {
    ok: false,
    stage,
    error: {
      message: "Capture API unavailable or health() is missing.",
    },
    diagnostics: buildDiagnostics(),
  };
}
const value = api.health();
return {
  ok: true,
  stage,
  value,
  diagnostics: buildDiagnostics({
    pageState: value?.pageState ?? null,
    messageCount: typeof value?.messageCount === "number" ? value.messageCount : null,
    dirty: value?.dirty ?? false,
    pendingUpdate: value?.pendingUpdate ?? false,
    observed: value?.observed ?? false,
    visibilityState: value?.visibilityState ?? null,
    lastMutationAt: value?.lastMutationAt ?? null,
    lastSnapshotAt: value?.lastSnapshotAt ?? null,
  }),
};
`,
);

export const COLLECT_SNAPSHOT_SCRIPT = createWrappedScript(
	"collect",
	`
const api = getApi();
if (!api || typeof api.collect !== "function") {
  return {
    ok: false,
    stage,
    error: {
      message: "Capture API unavailable or collect() is missing.",
    },
    diagnostics: buildDiagnostics(),
  };
}
const value = api.collect();
return {
  ok: true,
  stage,
  value,
  diagnostics: buildDiagnostics({
    pageState: value?.pageState ?? null,
    messageCount: Array.isArray(value?.messages) ? value.messages.length : null,
    dirty: false,
    pendingUpdate: false,
  }),
};
`,
);

export function createBootstrapScript(maxHtmlSnippetLength: number): string {
	const extractorFactory = buildDomExtractorSource(maxHtmlSnippetLength);
	return createWrappedScript(
		"bootstrap",
		`
const version = ${JSON.stringify(EXTRACTOR_VERSION)};
const existing = getApi();
if (existing && existing.version === version) {
  return {
    ok: true,
    stage,
    value: {
      installed: true,
      reusedExisting: true,
      version,
      installedAt:
        typeof existing.installedAt === "string" ? existing.installedAt : undefined,
    },
    diagnostics: buildDiagnostics(),
  };
}

const extractor = ${extractorFactory};
const installedAt = new Date().toISOString();
window.__obsidianChatCapture__ = {
  version,
  installedAt,
  health: extractor.health,
  collect: extractor.collect,
  getDiagnostics: extractor.getDiagnostics,
};
window.__OBSIDIAN_CAPTURE_COLLECT__ = extractor.collect;
return {
  ok: true,
  stage,
  value: {
    installed: true,
    reusedExisting: false,
    version,
    installedAt,
  },
  diagnostics: buildDiagnostics(),
};
`,
	);
}

export type HealthcheckResult = CaptureHealth;
