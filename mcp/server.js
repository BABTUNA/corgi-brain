#!/usr/bin/env node
// Corgi Brain MCP server: lets an agent (Claude Code, Claude Desktop, any MCP client) ask the team's
// workflow library how to do something on a website instead of rediscovering the site itself.
// Reads go straight to the database with the public read key (RLS allows reads only); starting a new
// exploration goes through the bridge, which runs the explorer agents.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Settings: environment first, then the bridge's .env (only the public URL, anon key and port).
const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", "bridge", ".env");
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(readFileSync(envFile, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
  : {};
const env = (k, d = "") => process.env[k] || fileEnv[k] || d;
const SUPABASE_URL = env("SUPABASE_URL");
const ANON_KEY = env("SUPABASE_ANON_KEY");
const BRIDGE = env("CORGI_BRAIN_BRIDGE", env("PUBLIC_URL", "http://localhost:8787")).replace(/\/+$/, "");
if (!SUPABASE_URL || !ANON_KEY) {
  console.error("corgi-brain-mcp: set SUPABASE_URL and SUPABASE_ANON_KEY (or keep them in bridge/.env)");
  process.exit(1);
}
const db = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

async function embed(text) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/embed`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ input: text }),
  }).catch(() => null);
  return res?.ok ? (await res.json()).embedding : null;
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const json = (o) => text(JSON.stringify(o, null, 2));

// The trail in the form an agent can act on: what to click or fill, how to find it again, and
// the plain instruction a person would read.
const steps = (wf) => (wf.trail || []).map((s) => ({
  n: s.n, kind: s.kind, instruction: s.instruction,
  ...(s.target ? { element: s.target } : {}),
  ...(s.fid ? { fingerprint: s.fid } : {}),
  ...(s.field ? { field: s.field } : {}),
  ...(s.href ? { href: s.href } : {}),
  ...(s.url ? { urlAfter: s.url } : {}),
}));
const card = (wf, score) => ({
  id: wf.id, task: wf.task, site: wf.site, startUrl: wf.startUrl,
  taughtBy: wf.taughtBy === "agent" ? `discovered by ${wf.agentCount === 1 ? "a Claude agent" : `${wf.agentCount || "several"} Claude agents`}` : `recorded by ${wf.recordedBy || "a teammate"}`,
  stepCount: (wf.trail || []).length,
  guideUrl: `${BRIDGE}/guide/${wf.id}`,
  ...(score != null ? { score: Math.round(score * 10000) / 10000 } : {}),
});

const server = new McpServer({ name: "corgi-brain", version: "0.1.0" });

server.registerTool("ask", {
  title: "Ask the team's brain",
  description: "Ask how this team does something in its web apps (e.g. 'how do I add a Codespaces secret?'). Corgi Brain answers in the team's Ask room from workflows teammates recorded and agents discovered, and returns the matching workflows with their steps. The question and answer are visible to the team. Use run_workflow with a returned id to do it.",
  inputSchema: { question: z.string().min(3).max(500), agentName: z.string().max(40).optional().describe("How to label you in the room, e.g. 'Claude Code'") },
}, async ({ question, agentName }) => {
  const res = await fetch(`${BRIDGE}/ask`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, author: agentName || "Claude Code", authorKind: "agent" }),
  }).catch((err) => ({ ok: false, statusText: err.message }));
  if (!res.ok) return text(`Could not reach Corgi Brain at ${BRIDGE}: ${res.statusText || res.status}`);
  const { answer } = await res.json();
  return json({
    answer: answer.body,
    workflows: answer.cards.map((c) => ({ id: c.id, task: c.task, site: c.site, taught: c.who, steps: c.steps, guideUrl: `${BRIDGE}/guide/${c.id}` })),
    ...(answer.meta?.gap ? { gap: "Nobody on the team has taught this yet.", ...(answer.meta.explore ? { canExplore: answer.meta.explore } : {}) } : {}),
  });
});

server.registerTool("search_workflows", {
  title: "Search the workflow library",
  description: "Find verified, step-by-step paths for doing something on a website (e.g. 'start a return on Amazon', 'download Python for macOS'). Searches by meaning, so plain-language questions work. Call this before exploring a site yourself.",
  inputSchema: { query: z.string().min(2).describe("What the user wants to do, in plain words"), site: z.string().optional().describe("Optional hostname to restrict to, e.g. github.com"), limit: z.number().int().min(1).max(10).optional() },
}, async ({ query, site, limit }) => {
  const { data, error } = await db.rpc("hybrid_search", { query_text: query, query_embedding: await embed(query), match_count: (limit || 5) * (site ? 3 : 1) });
  if (error) return text(`Search failed: ${error.message}`);
  const hits = data.filter((r) => !site || r.doc.site === site.replace(/^www\./, "")).slice(0, limit || 5);
  if (!hits.length) return text(`No workflow in the library matches "${query}". You can start one with explore_site.`);
  return json(hits.map((r) => ({ ...card(r.doc, r.score), steps: steps(r.doc).map((s) => s.instruction) })));
});

server.registerTool("get_workflow", {
  title: "Get a workflow's steps",
  description: "Full step list for one workflow: each step's instruction, the element to click or field to fill, and a fingerprint for finding the element again. Use the id from search_workflows.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const { data, error } = await db.from("workflows").select("doc").eq("id", id).maybeSingle();
  if (error) return text(`Lookup failed: ${error.message}`);
  if (!data) return text(`No workflow with id "${id}".`);
  return json({ ...card(data.doc), verified: data.doc.taughtBy === "agent" ? "judged by Claude from the agent's screenshots" : "recorded by a person and cleaned by Claude", steps: steps(data.doc) });
});

server.registerTool("run_workflow", {
  title: "Run a saved workflow",
  description: "Replay a saved workflow in a headless browser and get the page it ends on (URL, title, text). No model calls: a known path runs in seconds for $0, instead of exploring the site again. If the site changed and a step no longer matches, the workflow heals itself (a Claude agent repairs the path from the broken step and the library is updated). Use the id from search_workflows. Fill steps recorded by people need values: pass inputs keyed by step number.",
  inputSchema: {
    id: z.string(),
    inputs: z.record(z.string(), z.string()).optional().describe('Values for fill steps, keyed by step number, e.g. {"2": "running shoes"}'),
    heal: z.boolean().optional().describe("Repair the path if it broke (default true)"),
  },
}, async ({ id, inputs, heal }) => {
  const res = await fetch(`${BRIDGE}/workflows/${encodeURIComponent(id)}/run`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: inputs || {}, heal: heal !== false, caller: "mcp" }),
  }).catch((err) => ({ ok: false, statusText: err.message }));
  if (!res.ok) return text(`Could not run the workflow (is the Corgi Brain bridge running at ${BRIDGE}?): ${res.statusText || res.status}`);
  const r = await res.json();
  return json({
    ok: r.ok, seconds: r.seconds, costUsd: r.costUsd,
    saved: r.ok ? `${r.saved.seconds}s and $${r.saved.usd} compared with exploring from scratch` : null,
    healed: r.healed, ...(r.healFailed ? { healFailed: r.healFailed } : {}),
    ...(r.ok ? {} : { failedAt: r.failedAt, reason: r.reason }),
    finalUrl: r.finalUrl, title: r.title, pageText: r.pageText,
    steps: r.steps.map((s) => `${s.n}. ${s.instruction} [${s.status}${s.how ? `, matched by ${s.how}` : ""}]`),
  });
});

server.registerTool("list_sites", {
  title: "List sites in the library",
  description: "Every website the library knows, with how many workflows each has.",
  inputSchema: {},
}, async () => {
  const { data, error } = await db.from("workflows").select("site");
  if (error) return text(`Lookup failed: ${error.message}`);
  const counts = {};
  for (const r of data) counts[r.site] = (counts[r.site] || 0) + 1;
  return json(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([site, workflows]) => ({ site, workflows })));
});

server.registerTool("explore_site", {
  title: "Send agents to discover a new workflow",
  description: "When the library has nothing, race several Claude agents (each in its own browser) toward a goal on a public website. Takes one to three minutes; returns an exploration id and a live URL. Poll get_exploration for the result. Public sites only: agents never log in.",
  inputSchema: { goal: z.string().min(4).max(300), url: z.string().url(), agents: z.number().int().min(1).max(6).optional() },
}, async ({ goal, url, agents }) => {
  const res = await fetch(`${BRIDGE}/explore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal, url, agents: agents || 3 }) }).catch((err) => ({ ok: false, statusText: err.message }));
  if (!res.ok) return text(`Could not start the exploration (is the Corgi Brain bridge running at ${BRIDGE}?): ${res.statusText || res.status}`);
  const ex = await res.json();
  return json({ explorationId: ex.id, watchLive: `${BRIDGE}/explore/${ex.id}`, agents: ex.agents.length, next: "Call get_exploration with this id in about a minute." });
});

server.registerTool("get_exploration", {
  title: "Check an exploration",
  description: "Status of an exploration started with explore_site: each agent's outcome, the judge's verdicts, and the saved workflow id once one wins.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const { data, error } = await db.from("explorations").select("doc").eq("id", id).maybeSingle();
  if (error) return text(`Lookup failed: ${error.message}`);
  if (!data) return text(`No exploration with id "${id}".`);
  const ex = data.doc;
  return json({
    status: ex.status, goal: ex.goal, costUsd: ex.cost,
    winner: ex.winner ? { workflowId: ex.winner.workflowId, agent: ex.winner.agent + 1 } : null,
    agents: ex.agents.map((a) => ({ agent: a.i + 1, strategy: a.strategy, status: a.status, outcome: a.outcome, steps: a.steps, judge: (a.evals || []).map((e) => `${e.slug}: ${e.rating ?? (e.passed ? "pass" : "fail")}`) })),
  });
});

await server.connect(new StdioServerTransport());
