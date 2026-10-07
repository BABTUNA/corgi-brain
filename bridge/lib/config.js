// Loads settings for the bridge. Keys come from the shell or from bridge/.env and never leave
// this process, except the public read key, which is public by design (RLS guards reads).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BRIDGE_DIR = join(here, "..");

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const localEnv = readEnvFile(join(BRIDGE_DIR, ".env"));
const env = (k, d = "") => process.env[k] || localEnv[k] || d;

export const config = {
  port: Number(env("PORT", 8787)),
  publicUrl: env("PUBLIC_URL", "http://localhost:8787"),
  // Set when served under a path prefix, e.g. "/compute/v1/bridge" on the hosted deployment.
  basePath: env("BASE_PATH", "").replace(/\/+$/, ""),
  anthropicKey: env("ANTHROPIC_API_KEY"),
  // Cleanup, vision fallback and the explorer agents.
  model: env("BB_MODEL", "claude-sonnet-5-5"),
  // Scores every explorer's run after the race.
  judgeModel: env("JUDGE_MODEL", "claude-opus-5-5"),
  exploreAgents: Number(env("EXPLORE_AGENTS", 3)),
  maxActions: Number(env("EXPLORE_MAX_ACTIONS", 25)),
  // Shared secret the brain keeper (an Agent37 agent) sends as x-keeper-token.
  keeperToken: env("KEEPER_TOKEN"),
  supabaseUrl: env("SUPABASE_URL"),
  supabaseAnonKey: env("SUPABASE_ANON_KEY"),
  supabaseServiceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
};

if (!config.supabaseUrl || !config.supabaseServiceKey) {
  console.error("[config] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in bridge/.env");
  process.exit(1);
}
