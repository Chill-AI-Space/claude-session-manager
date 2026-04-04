/**
 * Universal AI completion client — pure fetch, no SDK dependencies.
 * Routes to OpenAI, Anthropic, or Google based on model name prefix.
 */
import { getSetting } from "./db";

// ── Provider detection ───────────────────────────────────────────────────────

type Provider = "openai" | "anthropic" | "google";

function detectProvider(model: string): Provider {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  return "openai"; // gpt-*, o1-*, o3-*, o4-*, etc.
}

const SETTING_KEY: Record<Provider, string> = {
  openai: "openai_api_key",
  anthropic: "anthropic_api_key",
  google: "google_ai_api_key",
};

const ENV_KEY: Record<Provider, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY"],
};

/** Fallback models when the requested provider's key is missing (ordered by preference) */
const FALLBACK_MODEL: Record<Provider, [Provider, string][]> = {
  openai: [["google", "gemini-2.5-flash"], ["anthropic", "claude-haiku-3-5-20241022"]],
  google: [["openai", "gpt-4o-mini"], ["anthropic", "claude-haiku-3-5-20241022"]],
  anthropic: [["google", "gemini-2.5-flash"], ["openai", "gpt-4o-mini"]],
};

function getEnvKey(provider: Provider): string | undefined {
  for (const envVar of ENV_KEY[provider]) {
    if (process.env[envVar]) return process.env[envVar];
  }
  return undefined;
}

function hasApiKey(provider: Provider): boolean {
  return !!(getSetting(SETTING_KEY[provider]) || getEnvKey(provider));
}

function getApiKey(provider: Provider): string {
  const key = getSetting(SETTING_KEY[provider]) || getEnvKey(provider);
  if (!key) {
    throw new Error(
      `No API key configured for ${provider}. Set "${SETTING_KEY[provider]}" in Settings or ${ENV_KEY[provider].join("/")} env var.`
    );
  }
  return key;
}

/**
 * If the requested model's provider has no API key, try to find
 * a fallback provider that does have a key configured.
 * Returns { model, provider } — possibly different from input.
 */
function resolveWithFallback(model: string): { model: string; provider: Provider } {
  const provider = detectProvider(model);
  if (hasApiKey(provider)) return { model, provider };

  // Try fallbacks in preference order
  for (const [fbProvider, fbModel] of FALLBACK_MODEL[provider]) {
    if (hasApiKey(fbProvider)) {
      return { model: fbModel, provider: fbProvider };
    }
  }

  // No fallback available — will throw in getApiKey
  return { model, provider };
}

// ── Model context window limits (tokens) ─────────────────────────────────────

const CONTEXT_LIMITS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  "o4-mini": 200_000,
  "gpt-5": 200_000, // conservative estimate
  // Anthropic
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-3-5-20241022": 200_000,
  // Google
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
};

/** Rough context limit for a model (defaults to 128K if unknown) */
export function getContextLimit(model: string): number {
  if (CONTEXT_LIMITS[model]) return CONTEXT_LIMITS[model];
  for (const [prefix, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (model.startsWith(prefix)) return limit;
  }
  return 128_000;
}

// ── Completion ───────────────────────────────────────────────────────────────

export interface CompletionOptions {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  model: string;
}

/**
 * Send a one-shot completion to any supported provider.
 * Returns the assistant's text response.
 */
export async function completion(opts: CompletionOptions): Promise<CompletionResult> {
  const { model: requestedModel, systemPrompt, userPrompt, maxTokens = 4096, temperature = 0.3 } = opts;

  const resolved = resolveWithFallback(requestedModel);
  const apiKey = getApiKey(resolved.provider);

  switch (resolved.provider) {
    case "openai":
      return callOpenAI(apiKey, resolved.model, systemPrompt, userPrompt, maxTokens, temperature);
    case "anthropic":
      return callAnthropic(apiKey, resolved.model, systemPrompt, userPrompt, maxTokens, temperature);
    case "google":
      return callGoogle(apiKey, resolved.model, systemPrompt, userPrompt, maxTokens, temperature);
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

async function callOpenAI(
  apiKey: string, model: string, system: string | undefined,
  user: string, maxTokens: number, temperature: number
): Promise<CompletionResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
    model: data.model ?? model,
  };
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function callAnthropic(
  apiKey: string, model: string, system: string | undefined,
  user: string, maxTokens: number, temperature: number,
  baseUrl = "https://api.anthropic.com"
): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: user }],
  };
  if (system) body.system = system;

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find((b: { type: string }) => b.type === "text");
  return {
    text: textBlock?.text ?? "",
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
    model: data.model ?? model,
  };
}

// ── Google (Gemini) ──────────────────────────────────────────────────────────

async function callGoogle(
  apiKey: string, model: string, system: string | undefined,
  user: string, maxTokens: number, temperature: number
): Promise<CompletionResult> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  if (system) {
    contents.push({ role: "user", parts: [{ text: system }] });
    contents.push({ role: "model", parts: [{ text: "Understood." }] });
  }
  contents.push({ role: "user", parts: [{ text: user }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google AI API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount,
    outputTokens: data.usageMetadata?.candidatesTokenCount,
    model,
  };
}

// ── Map/Reduce for long transcripts ──────────────────────────────────────────

/** Rough token estimate: ~4 chars per token for English, ~2 for mixed/code */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Summarize a long text using map/reduce if it exceeds the model's context.
 * - If it fits → single call.
 * - If not → split into chunks, summarize each, then combine.
 */
export async function summarizeWithMapReduce(opts: {
  model: string;
  systemPrompt: string;
  text: string;
  maxOutputTokens?: number;
}): Promise<CompletionResult> {
  const { model, systemPrompt, text, maxOutputTokens = 4096 } = opts;
  const contextLimit = getContextLimit(model);
  // Reserve space for system prompt + output tokens
  const promptOverhead = estimateTokens(systemPrompt) + maxOutputTokens + 500;
  const availableForInput = contextLimit - promptOverhead;
  const textTokens = estimateTokens(text);

  // Single call if it fits
  if (textTokens <= availableForInput) {
    return completion({
      model,
      systemPrompt,
      userPrompt: text,
      maxTokens: maxOutputTokens,
    });
  }

  // Map phase: split into chunks, summarize each
  const chunkSize = Math.floor(availableForInput * 3.5); // back to chars
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

  const chunkSummaries = await Promise.all(
    chunks.map((chunk, idx) =>
      completion({
        model,
        systemPrompt: `You are summarizing part ${idx + 1} of ${chunks.length} of a session transcript. Extract key actions, decisions, and outcomes. Be concise but specific. Include file names and concrete details.`,
        userPrompt: chunk,
        maxTokens: 2048,
      })
    )
  );

  // Reduce phase: combine chunk summaries into final summary
  const combined = chunkSummaries
    .map((r, i) => `=== Part ${i + 1} of ${chunks.length} ===\n${r.text}`)
    .join("\n\n");

  const finalResult = await completion({
    model,
    systemPrompt,
    userPrompt: combined,
    maxTokens: maxOutputTokens,
  });

  // Sum up token usage across all calls
  const totalInput = chunkSummaries.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0) + (finalResult.inputTokens ?? 0);
  const totalOutput = chunkSummaries.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0) + (finalResult.outputTokens ?? 0);

  return {
    text: finalResult.text,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    model: finalResult.model,
  };
}
