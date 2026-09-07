/**
 * One Anthropic client, optionally routed through a gateway.
 *
 * OpenRouter implements the Anthropic Messages API at /api/v1/messages, and
 * verified against this account it passes through everything this codebase
 * relies on: `output_config.format` (schema-constrained JSON), `output_config.effort`,
 * tool use, and prompt caching fields. So pointing the official SDK at it is
 * enough - no second SDK, no parallel code path to keep in sync.
 *
 * The one difference is naming: OpenRouter namespaces models as
 * `anthropic/claude-opus-5`. `modelId()` adds that prefix only when routed, so
 * the rest of the code keeps using plain Anthropic ids.
 */
import Anthropic from "@anthropic-ai/sdk";

/**
 * The SDK appends `/v1/messages` to the base URL, so the base must NOT already
 * end in /v1 - `https://openrouter.ai/api/v1` becomes `/api/v1/v1/messages` and
 * returns OpenRouter's 404 HTML page, which surfaces as a wall of Next.js markup
 * in the error. Both forms are accepted here because writing the /v1 is the
 * natural mistake: OpenRouter's own docs give the endpoint as `/api/v1/messages`.
 */
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
const KEY = (process.env.ANTHROPIC_API_KEY || "").trim();

export const viaOpenRouter = /openrouter\.ai/i.test(BASE_URL);

export const client = new Anthropic({
  apiKey: KEY || "missing",
  ...(BASE_URL ? { baseURL: BASE_URL } : {}),
});

/** True when a key is configured at all - used to fail with a sentence rather
 *  than the SDK's raw auth error. */
export function llmConfigured(): boolean {
  return KEY.length > 0;
}

export function modelId(name: string): string {
  if (!viaOpenRouter) return name;
  // Already namespaced (someone set the full id in env) - leave it alone.
  if (name.includes("/")) return name;
  // OpenRouter uses dots where the first-party ids use dashes for the minor
  // version: claude-haiku-4-5 -> anthropic/claude-haiku-4.5.
  const or = name.replace(/^(claude-[a-z]+)-(\d+)-(\d+)$/, "$1-$2.$3");
  return `anthropic/${or}`;
}

/** Human-readable description of where requests are going, for logs. */
export function llmTarget(): string {
  if (!llmConfigured()) return "not configured";
  return viaOpenRouter ? `OpenRouter (${BASE_URL})` : "Anthropic API";
}

/** Safe-to-publish view of the LLM wiring, so the UI can say whether "Compile
 *  with AI" will work BEFORE the user clicks it and gets an error. Never
 *  includes the key. */
export function llmStatus(): { configured: boolean; via: string; model: string } {
  return {
    configured: llmConfigured(),
    via: viaOpenRouter ? "OpenRouter" : BASE_URL ? "custom gateway" : "Anthropic",
    model: process.env.COMPILE_MODEL || "claude-opus-5",
  };
}
