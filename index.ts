/**
 * Cloudflare AI Gateway Provider Extension
 *
 * Routes Anthropic and OpenAI requests through Cloudflare AI Gateway
 * for observability, caching, rate limiting, and fallbacks.
 * Optionally adds Cloudflare Workers AI models.
 *
 * Config is read from config.json next to this file (preferred), with env var fallbacks.
 *
 * config.json fields:
 *   accountId    - Your Cloudflare account ID
 *   gatewayName  - Your AI Gateway name (slug)
 *   apiToken     - Cloudflare API token (enables Workers AI models, optional)
 *   gatewayToken - Gateway auth token (if gateway requires authentication, optional)
 *   skipAnthropic - true to skip overriding Anthropic (optional)
 *   skipOpenAI    - true to skip overriding OpenAI (optional)
 *   skipGoogle    - true to skip overriding Google (optional)
 *
 * Env var fallbacks (used when config.json field is empty/missing):
 *   CF_ACCOUNT_ID, CF_GATEWAY_NAME, CF_API_TOKEN,
 *   CF_GATEWAY_TOKEN, CF_GATEWAY_SKIP_ANTHROPIC,
 *   CF_GATEWAY_SKIP_OPENAI, CF_GATEWAY_SKIP_GOOGLE
 *
 * Usage:
 *   Fill in config.json, then /reload (or restart pi).
 *   All Anthropic/OpenAI/Google requests flow through your gateway.
 *   Use /model to pick a Workers AI model if apiToken is set.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  try {
    const raw = readFileSync(join(__dirname, "config.json"), "utf8");
    return JSON.parse(raw) as {
      accountId?: string;
      gatewayName?: string;
      apiToken?: string;
      gatewayToken?: string;
      skipAnthropic?: boolean;
      skipOpenAI?: boolean;
      skipGoogle?: boolean;
    };
  } catch {
    return {};
  }
}

function resolve(jsonVal: string | undefined, envVar: string): string {
  const trimmed = jsonVal?.trim();
  if (trimmed) return trimmed;
  return process.env[envVar] ?? "";
}

function resolveFlag(jsonVal: boolean | undefined, envVar: string): boolean {
  if (jsonVal !== undefined) return jsonVal;
  return process.env[envVar] === "1";
}

// Workers AI models available through Cloudflare
// See: https://developers.cloudflare.com/workers-ai/models/
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const BASE_COMPAT = { supportsDeveloperRole: false, maxTokensField: "max_tokens" as const };

const WORKERS_AI_MODELS = [
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    name: "Llama 3.3 70B Instruct (Workers AI)",
    reasoning: false as const,
    input: ["text"] as ("text" | "image")[],
    cost: FREE_COST,
    contextWindow: 128000,
    maxTokens: 8192,
    compat: BASE_COMPAT,
  },
  {
    id: "@cf/meta/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B Instruct (Workers AI)",
    reasoning: false as const,
    input: ["text"] as ("text" | "image")[],
    cost: FREE_COST,
    contextWindow: 128000,
    maxTokens: 8192,
    compat: BASE_COMPAT,
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct",
    name: "Llama 3.1 8B Instruct (Workers AI)",
    reasoning: false as const,
    input: ["text"] as ("text" | "image")[],
    cost: FREE_COST,
    contextWindow: 128000,
    maxTokens: 4096,
    compat: BASE_COMPAT,
  },
  {
    id: "@cf/google/gemma-3-27b-it",
    name: "Gemma 3 27B (Workers AI)",
    reasoning: false as const,
    input: ["text"] as ("text" | "image")[],
    cost: FREE_COST,
    contextWindow: 131072,
    maxTokens: 8192,
    compat: BASE_COMPAT,
  },
  {
    id: "@cf/mistral/mistral-7b-instruct-v0.1",
    name: "Mistral 7B Instruct (Workers AI)",
    reasoning: false as const,
    input: ["text"] as ("text" | "image")[],
    cost: FREE_COST,
    contextWindow: 32768,
    maxTokens: 4096,
    compat: BASE_COMPAT,
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    name: "Qwen 2.5 Coder 32B (Workers AI)",
    reasoning: false as const,
    input: ["text"] as ("text" | "image")[],
    cost: FREE_COST,
    contextWindow: 32768,
    maxTokens: 8192,
    compat: BASE_COMPAT,
  },
  {
    id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    name: "DeepSeek R1 Distill Qwen 32B (Workers AI)",
    reasoning: true as const,
    input: ["text"] as ("text" | "image")[],
    cost: FREE_COST,
    contextWindow: 32768,
    maxTokens: 8192,
    compat: { ...BASE_COMPAT, thinkingFormat: "openai" as const },
  },
  {
    id: "@cf/moonshotai/kimi-k2.5",
    name: "Kimi K2.5 (Workers AI)",
    reasoning: true as const,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 32768,
    compat: { ...BASE_COMPAT, thinkingFormat: "openai" as const },
  },
];

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();

  const accountId = resolve(cfg.accountId, "CF_ACCOUNT_ID");
  const gatewayName = resolve(cfg.gatewayName, "CF_GATEWAY_NAME");

  if (!accountId || !gatewayName) {
    // Silently skip — fill in config.json or set env vars to activate
    return;
  }

  const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}`;

  const gatewayToken = resolve(cfg.gatewayToken, "CF_GATEWAY_TOKEN");
  const extraHeaders = gatewayToken
    ? { headers: { "cf-aig-authorization": `Bearer ${gatewayToken}` } }
    : {};

  const skipAnthropic = resolveFlag(cfg.skipAnthropic, "CF_GATEWAY_SKIP_ANTHROPIC");
  const skipOpenAI = resolveFlag(cfg.skipOpenAI, "CF_GATEWAY_SKIP_OPENAI");
  const skipGoogle = resolveFlag(cfg.skipGoogle, "CF_GATEWAY_SKIP_GOOGLE");
  const apiToken = resolve(cfg.apiToken, "CF_API_TOKEN");

  const activeProviders: string[] = [];

  // ─── Route Anthropic through the gateway ──────────────────────────────────
  if (!skipAnthropic) {
    pi.registerProvider("anthropic", { baseUrl: `${gatewayBase}/anthropic`, ...extraHeaders });
    activeProviders.push("Anthropic");
  }

  // ─── Route OpenAI through the gateway ─────────────────────────────────────
  if (!skipOpenAI) {
    pi.registerProvider("openai", { baseUrl: `${gatewayBase}/openai`, ...extraHeaders });
    activeProviders.push("OpenAI");
  }

  // ─── Route Google through the gateway ─────────────────────────────────────
  if (!skipGoogle) {
    pi.registerProvider("google", { baseUrl: `${gatewayBase}/google-ai-studio`, ...extraHeaders });
    activeProviders.push("Google");
  }

  // ─── Cloudflare Workers AI models (optional) ──────────────────────────────
  // Only registered when apiToken is set.
  // Workers AI is OpenAI-compatible through the gateway at:
  //   https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/workers-ai/v1
  if (apiToken) {
    pi.registerProvider("cloudflare-workers-ai", {
      baseUrl: `${gatewayBase}/workers-ai/v1`,
      apiKey: apiToken,
      api: "openai-completions",
      authHeader: true,
      ...extraHeaders,
      models: WORKERS_AI_MODELS,
    });
    activeProviders.push("Workers AI");
  }

  const activeProvidersLabel = activeProviders.join(", ");

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      `Cloudflare AI Gateway active (${gatewayName}): ${activeProvidersLabel}`,
      "info",
    );
  });
}
