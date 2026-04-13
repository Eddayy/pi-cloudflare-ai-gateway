/**
 * Cloudflare Workers AI Provider Extension
 *
 * Dynamically fetches available text generation models from the Cloudflare API
 * and registers them via the AI Gateway.
 *
 * config.json fields:
 *   accountId    - Your Cloudflare account ID
 *   gatewayName  - Your AI Gateway name (slug)
 *   apiToken     - Cloudflare API token
 *   gatewayToken - Gateway auth token (if gateway requires authentication, optional)
 *
 * Env var fallbacks:
 *   CF_ACCOUNT_ID, CF_GATEWAY_NAME, CF_API_TOKEN, CF_GATEWAY_TOKEN
 *
 * Usage:
 *   Fill in config.json, then /reload (or restart pi).
 *   Use /model to pick a Workers AI model.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
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

// Models known to support reasoning/thinking mode
const REASONING_MODELS = new Set([
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/moonshotai/kimi-k2.5",
]);

interface CFModel {
  name: string;
  properties: Array<{ property_id: string; value: unknown }>;
  schema?: {
    input?: {
      properties?: {
        max_tokens?: { maximum?: number; default?: number };
        image?: unknown;
      };
    };
  };
}

function mapModel(m: CFModel) {
  const props = new Map(m.properties.map((p) => [p.property_id, p.value]));

  const contextWindow = parseInt((props.get("context_window") as string) ?? "32768", 10);

  const prices = props.get("price") as Array<{ unit: string; price: number }> | undefined;
  const inputPrice = prices?.find((p) => p.unit.includes("input"))?.price ?? 0;
  const outputPrice = prices?.find((p) => p.unit.includes("output"))?.price ?? 0;
  const cacheReadPrice = prices?.find((p) => p.unit.includes("cache"))?.price ?? 0;

  const inputProps = m.schema?.input?.properties;
  const maxTokens =
    inputProps?.max_tokens?.maximum ??
    inputProps?.max_tokens?.default ??
    Math.min(Math.floor(contextWindow / 4), 8192);

  const isReasoning = REASONING_MODELS.has(m.name);

  return {
    id: m.name,
    name: `${m.name.replace(/^@cf\//, "")} (Workers AI)`,
    reasoning: isReasoning,
    input: (inputProps?.image ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: { input: inputPrice, output: outputPrice, cacheRead: cacheReadPrice, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens" as const,
      ...(isReasoning ? { thinkingFormat: "openai" as const } : {}),
    },
  };
}

async function fetchTextGenerationModels(accountId: string, apiToken: string): Promise<CFModel[] | null> {
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?task=Text+Generation&per_page=100`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { success: boolean; result: CFModel[] };
    return json.success ? json.result : null;
  } catch {
    return null;
  }
}

export default async function (pi: ExtensionAPI) {
  pi.registerCommand("cf-setup", {
    description: "Configure Cloudflare Workers AI (account ID, gateway, API token)",
    handler: async (_args, ctx) => {
      const accountId = await ctx.ui.input("Cloudflare Account ID", "f009c417...");
      if (accountId === undefined) return;

      const gatewayName = await ctx.ui.input("AI Gateway name (slug)", "my-gateway");
      if (gatewayName === undefined) return;

      const apiToken = await ctx.ui.input("Cloudflare API token", "cfut_...");
      if (apiToken === undefined) return;

      const gatewayToken = await ctx.ui.input(
        "Gateway auth token (leave empty if not required)",
        "optional",
      );
      if (gatewayToken === undefined) return;

      const config = {
        accountId: accountId.trim(),
        gatewayName: gatewayName.trim(),
        apiToken: apiToken.trim(),
        gatewayToken: gatewayToken.trim(),
      };

      writeFileSync(join(__dirname, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
      ctx.ui.notify("Cloudflare config saved — reloading…", "info");
      await ctx.reload();
    },
  });


  const cfg = loadConfig();

  const accountId = resolve(cfg.accountId, "CF_ACCOUNT_ID");
  const gatewayName = resolve(cfg.gatewayName, "CF_GATEWAY_NAME");
  const apiToken = resolve(cfg.apiToken, "CF_API_TOKEN");

  if (!accountId || !gatewayName || !apiToken) return;

  const cfModels = await fetchTextGenerationModels(accountId, apiToken);

  if (!cfModels) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("Cloudflare Workers AI: failed to fetch model list", "error");
    });
    return;
  }

  const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}`;
  const gatewayToken = resolve(cfg.gatewayToken, "CF_GATEWAY_TOKEN");
  const extraHeaders = gatewayToken
    ? { headers: { "cf-aig-authorization": `Bearer ${gatewayToken}` } }
    : {};

  pi.registerProvider("cloudflare-workers-ai", {
    baseUrl: `${gatewayBase}/workers-ai/v1`,
    apiKey: apiToken,
    api: "openai-completions",
    authHeader: true,
    ...extraHeaders,
    models: cfModels.map(mapModel),
  });

  const modelCount = cfModels.length;
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`Cloudflare Workers AI active (${gatewayName}): ${modelCount} models`, "info");
  });
}
