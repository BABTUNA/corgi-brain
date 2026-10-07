// The brain keeper: an Agent37 agent that wakes every night on a platform cron, has Corgi Brain
// check every workflow (healing broken ones), and posts a short morning report in the Ask room.
//
//   node scripts/keeper.js setup      create the Agent37 instance and its nightly cron
//   node scripts/keeper.js run        fire the cron now (for a demo) and follow the agent's turn
//   node scripts/keeper.js status     instance, cron and the latest runs
//
// Needs AGENT37_API_KEY (env, bridge/.env, or ../.env.agent37) and KEEPER_TOKEN (bridge/.env).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readEnv = (p) => existsSync(p) ? Object.fromEntries(readFileSync(p, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]])) : {};
const env = { ...readEnv(join(here, "..", "..", ".env.agent37")), ...readEnv(join(here, "..", ".env")), ...process.env };
const KEY = env.AGENT37_API_KEY;
const TOKEN = env.KEEPER_TOKEN;
const BRAIN = (env.KEEPER_BRAIN_URL || "https://vwnptwlibsllqexidmrj.supabase.co/compute/v1/bridge").replace(/\/+$/, "");
const STATE = join(here, "..", ".keeper.json");
const API = "https://api.agent37.com/v1";

if (!KEY) { console.error("Set AGENT37_API_KEY (e.g. in ~/hackathons/corgi-hack-agent37/.env.agent37)."); process.exit(1); }
if (!TOKEN) { console.error("Set KEEPER_TOKEN in bridge/.env (the same value as the deployed secret)."); process.exit(1); }

async function a37(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}
const state = () => existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT = `You are Corgi Brain's brain keeper. Corgi Brain is a team's shared memory of how to get things done in web apps, and your job is to keep it current overnight.

Do exactly this, using your shell:

1. Check every workflow (takes a minute or two; wait for it):
   curl -s -m 600 -X POST "${BRAIN}/maintenance/check-all" -H "x-keeper-token: ${TOKEN}"

2. Read the JSON. It has checked, ok, healed, broken, skippedNeedsLogin, seconds and a results list (task, site, ok, healed, reason).

3. Write a short morning report for the team, at most 4 short lines, plain text, no markdown headings. Lead with the headline numbers, then name any workflow that healed or is still broken and why, in plain words. If everything passed, say so in one line.

4. Post it to the team's Ask room (escape the text as JSON):
   curl -s -X POST "${BRAIN}/maintenance/report" -H "x-keeper-token: ${TOKEN}" -H "content-type: application/json" -d '{"text": "<your report>", "stats": {"checked": N, "ok": N, "healed": N, "broken": N}}'

5. Reply with the report you posted.`;

async function setup() {
  let s = state();
  if (!s.instanceId) {
    const inst = await a37("/instances", { method: "POST", body: { name: "corgi-brain-keeper", auto_sleep: true, budget: { monthly_cap_micros: 3_000_000, credit_micros: 1_000_000 } } });
    s.instanceId = inst.id;
    writeFileSync(STATE, JSON.stringify(s, null, 2));
    console.log(`instance ${inst.id} created (${inst.status})`);
  }
  for (let i = 0; i < 90; i++) {
    const inst = await a37(`/instances/${s.instanceId}`);
    if (inst.status === "running" || inst.status === "sleeping") { console.log(`instance ${s.instanceId} is ${inst.status}`); break; }
    if (inst.status === "failed") throw new Error("instance failed to provision");
    await sleep(2000);
  }
  if (!s.cronId) {
    const cron = await a37(`/instances/${s.instanceId}/crons`, { method: "POST", body: { name: "Nightly brain check", prompt: PROMPT, schedule: "0 6 * * *", timezone: "America/Los_Angeles" } });
    s.cronId = cron.id;
    writeFileSync(STATE, JSON.stringify(s, null, 2));
    console.log(`cron ${cron.id}: every day at 6:00 Pacific, next ${new Date(cron.next_run * 1000).toLocaleString()}`);
  } else {
    await a37(`/instances/${s.instanceId}/crons/${s.cronId}`, { method: "PATCH", body: { prompt: PROMPT } });
    console.log(`cron ${s.cronId} prompt updated`);
  }
}

async function runNow() {
  const s = state();
  if (!s.instanceId || !s.cronId) throw new Error("run setup first");
  const run = await a37(`/instances/${s.instanceId}/crons/${s.cronId}/run`, { method: "POST" });
  console.log(`fired: ${run.status}${run.session_id ? `, session ${run.session_id}` : ""}`);
  if (!run.session_id) return;
  // Follow the agent's turn on the instance's own API.
  const base = `https://${s.instanceId}.agent37.app`;
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const res = await fetch(`${base}/v1/sessions/${run.session_id}`, { headers: { "x-agent37-key": KEY } });
    const sess = await res.json().catch(() => ({}));
    if (!sess.active_response_id && (sess.messages || sess.items || sess.history)) {
      const msgs = sess.messages || sess.items || sess.history;
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      const text = typeof last?.content === "string" ? last.content : (last?.content || []).map((c) => c.text || "").join("");
      console.log(`\nkeeper replied:\n${text || JSON.stringify(last).slice(0, 800)}`);
      return;
    }
    process.stdout.write(".");
  }
  console.log("\nstill running; check the Ask room or `node scripts/keeper.js status`");
}

async function status() {
  const s = state();
  if (!s.instanceId) return console.log("not set up");
  const inst = await a37(`/instances/${s.instanceId}`);
  console.log(`instance ${inst.id}: ${inst.status}`);
  if (s.cronId) {
    const cron = await a37(`/instances/${s.instanceId}/crons/${s.cronId}`);
    console.log(`cron "${cron.name}" ${cron.schedule} ${cron.timezone || ""}, next ${cron.next_run ? new Date(cron.next_run * 1000).toLocaleString() : "-"}`);
    const runs = await a37(`/instances/${s.instanceId}/crons/${s.cronId}/runs`);
    for (const r of (runs.data || []).slice(0, 5)) console.log(`  ${new Date((r.created || r.fired_at || 0) * 1000).toLocaleString()}  ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
  }
}

const cmd = process.argv[2];
await ({ setup, run: runNow, status }[cmd] || (async () => console.log("usage: node scripts/keeper.js setup|run|status")))();
