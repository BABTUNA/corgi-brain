import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

let client = null;
export function claude() {
  if (!config.anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

// Pull the first JSON object out of a model reply (tolerates code fences).
export function extractJson(text) {
  const stripped = String(text).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`model returned non-JSON: ${stripped.slice(0, 160)}`);
  return JSON.parse(match[0]);
}

export async function askJson({ system, content, maxTokens = 1500 }) {
  const res = await claude().messages.create({
    model: config.model,
    // Thinking tokens count toward max_tokens, so leave headroom above the answer size.
    max_tokens: maxTokens + 4000,
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content }],
  });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, json: () => extractJson(text) };
}
