type LocalModelReadinessTask = "resume-parse" | "ai-interview" | "generic";

type LocalModelReadinessCode =
  | "LOCAL_MODEL_UNAVAILABLE"
  | "INTERVIEW_MODEL_NOT_READY";

type LocalReadinessConfig = {
  baseUrl: string;
  model: string;
  generateEndpoint: string;
  timeoutMs: number;
};

type LocalReadinessResult =
  | {
      skipped: true;
      provider: string;
    }
  | {
      skipped: false;
      provider: "local";
      model: string;
      availableModelsCount: number;
    };

type CacheEntry =
  | {
      ok: true;
      expiresAt: number;
      value: LocalReadinessResult;
    }
  | {
      ok: false;
      expiresAt: number;
      value: LocalModelReadinessError;
    };

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
};

const DEFAULT_LOCAL_TIMEOUT_MS = 60_000;
const MAX_PREFLIGHT_TIMEOUT_MS = 8_000;
const MIN_PREFLIGHT_TIMEOUT_MS = 2_000;
const SUCCESS_CACHE_TTL_MS = 20_000;
const FAILURE_CACHE_TTL_MS = 8_000;

const globalForLocalReadiness = globalThis as unknown as {
  localReadinessCache?: Map<string, CacheEntry>;
  localReadinessInflight?: Map<string, Promise<LocalReadinessResult>>;
};

export class LocalModelReadinessError extends Error {
  readonly code: LocalModelReadinessCode;
  readonly status: number;
  readonly details?: string;

  constructor(input: {
    code: LocalModelReadinessCode;
    message: string;
    status?: number;
    details?: string;
  }) {
    super(input.message);
    this.code = input.code;
    this.status = input.status ?? 503;
    this.details = input.details;
  }
}

export function isLocalModelReadinessError(
  error: unknown,
): error is LocalModelReadinessError {
  return error instanceof LocalModelReadinessError;
}

function getReadinessCache() {
  if (!globalForLocalReadiness.localReadinessCache) {
    globalForLocalReadiness.localReadinessCache = new Map<string, CacheEntry>();
  }
  return globalForLocalReadiness.localReadinessCache;
}

function getReadinessInflight() {
  if (!globalForLocalReadiness.localReadinessInflight) {
    globalForLocalReadiness.localReadinessInflight = new Map<
      string,
      Promise<LocalReadinessResult>
    >();
  }
  return globalForLocalReadiness.localReadinessInflight;
}

function normalizeBaseUrl(raw: string) {
  return raw.trim().replace(/\/+$/, "");
}

function normalizeEndpoint(raw: string | undefined, fallback: string) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseTimeoutMs(raw: string | undefined) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOCAL_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

function toReadinessCode(task: LocalModelReadinessTask): LocalModelReadinessCode {
  return task === "ai-interview"
    ? "INTERVIEW_MODEL_NOT_READY"
    : "LOCAL_MODEL_UNAVAILABLE";
}

function createReadinessError(
  task: LocalModelReadinessTask,
  message: string,
  details?: string,
  status = 503,
) {
  return new LocalModelReadinessError({
    code: toReadinessCode(task),
    message,
    details,
    status,
  });
}

function getLocalConfig(task: LocalModelReadinessTask): LocalReadinessConfig {
  const baseUrlRaw = process.env.LOCAL_LLM_BASE_URL?.trim() ?? "";
  const model = process.env.LOCAL_LLM_MODEL?.trim() ?? "";

  if (!baseUrlRaw) {
    throw createReadinessError(
      task,
      "Local AI model is not configured. Missing LOCAL_LLM_BASE_URL.",
      "Set LOCAL_LLM_BASE_URL to your Ollama server URL (for example http://127.0.0.1:11434).",
      500,
    );
  }

  if (!model) {
    throw createReadinessError(
      task,
      "Local AI model is not configured. Missing LOCAL_LLM_MODEL.",
      "Set LOCAL_LLM_MODEL to an installed Ollama model (for example gemma3:4b-it-qat).",
      500,
    );
  }

  const timeoutMs = Math.min(
    MAX_PREFLIGHT_TIMEOUT_MS,
    Math.max(MIN_PREFLIGHT_TIMEOUT_MS, parseTimeoutMs(process.env.LOCAL_LLM_TIMEOUT_MS)),
  );

  return {
    baseUrl: normalizeBaseUrl(baseUrlRaw),
    model,
    generateEndpoint: normalizeEndpoint(
      process.env.LOCAL_LLM_GENERATE_ENDPOINT,
      "/api/generate",
    ),
    timeoutMs,
  };
}

function isLocalProviderEnabled() {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase() ?? "google";
  return provider === "local";
}

function toCacheKey(task: LocalModelReadinessTask) {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase() ?? "google";
  const base = process.env.LOCAL_LLM_BASE_URL?.trim() ?? "";
  const model = process.env.LOCAL_LLM_MODEL?.trim() ?? "";
  const endpoint = process.env.LOCAL_LLM_GENERATE_ENDPOINT?.trim() ?? "/api/generate";
  return `${provider}|${task}|${base}|${model}|${endpoint}`;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  task: LocalModelReadinessTask,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw createReadinessError(
        task,
        "Unable to reach local AI model service.",
        `HTTP ${response.status} from ${url}: ${text.slice(0, 240) || "no response body"}`,
        503,
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw createReadinessError(
        task,
        "Local AI model service returned an invalid response.",
        `Expected JSON from ${url}, received: ${text.slice(0, 240) || "empty response"}`,
        503,
      );
    }
  } catch (error) {
    if (isLocalModelReadinessError(error)) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw createReadinessError(
        task,
        "Local AI model service timed out.",
        `Timeout after ${timeoutMs}ms while calling ${url}.`,
        503,
      );
    }

    const message = error instanceof Error ? error.message : "Unknown network failure";
    throw createReadinessError(
      task,
      "Unable to connect to local AI model service.",
      `${url} -> ${message}`,
      503,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function splitModelName(value: string) {
  const [name, ...rest] = value.trim().toLowerCase().split(":");
  const tag = rest.length > 0 ? rest.join(":") : null;
  return { name, tag };
}

function modelMatches(requested: string, available: string) {
  const req = splitModelName(requested);
  const candidate = splitModelName(available);

  if (!req.name || !candidate.name || req.name !== candidate.name) {
    return false;
  }

  if (!req.tag || req.tag === "latest") {
    return true;
  }

  return candidate.tag === req.tag;
}

export async function pingOllama(
  config: LocalReadinessConfig,
  task: LocalModelReadinessTask,
) {
  const payload = await fetchJsonWithTimeout<OllamaTagsResponse>(
    `${config.baseUrl}/api/tags`,
    { method: "GET" },
    config.timeoutMs,
    task,
  );

  const availableModels = (payload.models ?? [])
    .map((item) => item.name ?? item.model ?? "")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    availableModels,
    raw: payload,
  };
}

export function ensureModelExists(
  modelName: string,
  availableModels: string[],
  task: LocalModelReadinessTask,
) {
  if (availableModels.length === 0) {
    throw createReadinessError(
      task,
      "No local AI models were found in Ollama.",
      "Run `ollama pull <model>` and retry.",
      503,
    );
  }

  const hasMatch = availableModels.some((candidate) =>
    modelMatches(modelName, candidate),
  );

  if (!hasMatch) {
    throw createReadinessError(
      task,
      `Local AI model "${modelName}" is not available.`,
      `Available models: ${availableModels.join(", ")}`,
      503,
    );
  }
}

export async function warmupModel(
  config: LocalReadinessConfig,
  task: LocalModelReadinessTask,
) {
  const payload = await fetchJsonWithTimeout<{
    response?: string;
    message?: { content?: string };
    error?: string;
  }>(
    `${config.baseUrl}${config.generateEndpoint}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        prompt: "Respond with READY only.",
        options: {
          temperature: 0,
          num_predict: 8,
        },
      }),
    },
    config.timeoutMs,
    task,
  );

  if (payload.error) {
    throw createReadinessError(
      task,
      `Local AI model "${config.model}" failed warmup.`,
      payload.error,
      503,
    );
  }

  const text = payload.response?.trim() ?? payload.message?.content?.trim() ?? "";
  if (!text) {
    throw createReadinessError(
      task,
      `Local AI model "${config.model}" returned an empty warmup response.`,
      "Ollama responded but no generated text was returned.",
      503,
    );
  }
}

export async function ensureLocalModelReady(
  task: LocalModelReadinessTask = "generic",
) {
  const cacheKey = toCacheKey(task);
  const cache = getReadinessCache();
  const inflight = getReadinessInflight();
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    if (cached.ok) {
      return cached.value;
    }
    throw cached.value;
  }

  const running = inflight.get(cacheKey);
  if (running) {
    return running;
  }

  const run = (async (): Promise<LocalReadinessResult> => {
    if (!isLocalProviderEnabled()) {
      return {
        skipped: true,
        provider: process.env.AI_PROVIDER?.trim().toLowerCase() || "google",
      };
    }

    const config = getLocalConfig(task);
    const { availableModels } = await pingOllama(config, task);
    ensureModelExists(config.model, availableModels, task);
    await warmupModel(config, task);

    return {
      skipped: false,
      provider: "local",
      model: config.model,
      availableModelsCount: availableModels.length,
    };
  })();

  inflight.set(cacheKey, run);

  try {
    const value = await run;
    cache.set(cacheKey, {
      ok: true,
      value,
      expiresAt: Date.now() + SUCCESS_CACHE_TTL_MS,
    });
    return value;
  } catch (error) {
    const normalized = isLocalModelReadinessError(error)
      ? error
      : createReadinessError(
          task,
          "Local AI model readiness check failed.",
          error instanceof Error ? error.message : "Unknown failure",
          503,
        );

    cache.set(cacheKey, {
      ok: false,
      value: normalized,
      expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
    });
    throw normalized;
  } finally {
    inflight.delete(cacheKey);
  }
}

