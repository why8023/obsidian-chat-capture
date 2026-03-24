import { EXTRACTOR_VERSION } from "../constants";
import { buildDomExtractorSource } from "./dom-extractor";

function createWrappedScript(stage: string, body: string): string {
	return `
(() => {
  const stage = ${JSON.stringify(stage)};
  const getApi = () => window.__obsidianChatCapture__;
  const buildDiagnostics = (overrides = {}) => {
    const currentApi = getApi();
    return {
      pageUrl: typeof location?.href === "string" ? location.href : null,
      pageTitle: typeof document?.title === "string" ? document.title : "",
      readyState: typeof document?.readyState === "string" ? document.readyState : "unknown",
      hasCaptureApi: Boolean(currentApi),
      captureVersion: typeof currentApi?.version === "string" ? currentApi.version : null,
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
