// Corgi Brain bridge: serves the extension, cleans recordings with Claude, keeps the workflow
// library, and runs Explore mode (Claude agents racing in local browsers to
// discover how to navigate a public site, streamed live).
import express from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, BRIDGE_DIR } from "./lib/config.js";
import { visionPick } from "./lib/vision.js";
import { cleanRecording } from "./lib/cleanup.js";
import { saveWorkflow, getWorkflow, listWorkflows, uniqueId, getExploration, listExplorations, logGuidedRun, guidedRunStats } from "./lib/store.js";
import { findWorkflow, searchLibrary } from "./lib/search.js";
import { embed, workflowText } from "./lib/embed.js";
import { startExploration } from "./lib/explore.js";
import { replayWorkflow, replayStats } from "./lib/replay.js";
import { ask, announce, requestRecording } from "./lib/ask.js";
import { skillZip, skillMarkdown } from "./lib/skill.js";
import { checkAll, postReport } from "./lib/keeper.js";
import { db } from "./lib/store.js";

const app = express();
// Behind a path prefix (the hosted deployment serves the bridge at /compute/v1/<name>): accept requests
// with or without the prefix, and point every root-relative link in outgoing HTML at it.
const BASE = config.basePath;
const withBase = (html) => html
  .replace(/((?:href|src|action)=["'])\/(?!\/)/g, `$1${BASE}/`)
  .replace(/(fetch\(\s*["'`])\/(?!\/)/g, `$1${BASE}/`)
  .replace(/(location\.href\s*=\s*["'`])\/(?!\/)/g, `$1${BASE}/`);
if (BASE) {
  app.use((req, res, next) => {
    if (req.url === BASE || req.url.startsWith(`${BASE}/`) || req.url.startsWith(`${BASE}?`)) req.url = req.url.slice(BASE.length) || "/";
    const send = res.send.bind(res);
    res.send = (body) => send(typeof body === "string" && /html/.test(res.get("content-type") || "") ? withBase(body) : body);
    const redirect = res.redirect.bind(res);
    res.redirect = (url) => redirect(typeof url === "string" && url.startsWith("/") ? BASE + url : url);
    next();
  });
}
const page = (name) => (_req, res) => res.type("html").send(readFileSync(join(BRIDGE_DIR, "public", name), "utf8"));
app.use(express.json({ limit: "20mb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "content-type, authorization, apikey, x-client-info");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(join(BRIDGE_DIR, "public"), { index: false }));
// The bridge carries its own logo and icons so it can be deployed on its own.
app.use("/assets", express.static(join(BRIDGE_DIR, "assets"), { index: false }));
app.use("/assets", express.static(join(BRIDGE_DIR, "..", "assets"), { index: false }));

// Public settings for the pages: the anon key only reads (RLS), and powers the live race.
app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(`window.SUPA = ${JSON.stringify({ url: config.supabaseUrl, anonKey: config.supabaseAnonKey })};`);
});

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const guideUrl = (id) => `${config.publicUrl}/guide/${id}`;
const summary = (wf, source) => ({
  found: true,
  id: wf.id,
  task: wf.task,
  site: wf.site,
  taughtBy: wf.taughtBy || "human",
  recordedBy: wf.recordedBy,
  recordedAt: wf.recordedAt,
  steps: wf.trail.map((s) => s.instruction),
  guideUrl: guideUrl(wf.id),
  ...(source ? { source } : {}),
});

// ── Routes the extension already calls ─────────────────────────────────────
app.post("/functions/vision-pick", async (req, res) => {
  try {
    res.json(await visionPick(req.body));
  } catch (err) {
    console.error("[vision]", err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post("/functions/log-session", (_req, res) => res.json({ category: "other" }));

app.post("/functions/moss-retrieve", (_req, res) => res.json({ hints: "" }));

// ── Record mode: raw events → Claude cleanup → workflow ─────────────────────
app.post("/record", async (req, res) => {
  const { task, site, startUrl, recordedBy, events } = req.body || {};
  if (!Array.isArray(events) || events.length < 2) return res.status(400).json({ error: "need at least 2 events" });
  const own = (e) => !String(e?.target?.id || "").startsWith("__evernav");
  const cleaned = await cleanRecording({ task, events: events.filter(own) });

  const wf = {
    id: await uniqueId(cleaned.task || task),
    task: cleaned.task || task || "Recorded workflow",
    site: site || "unknown",
    startUrl: startUrl || null,
    taughtBy: "human",
    recordedBy: recordedBy || "teammate",
    recordedAt: new Date().toISOString(),
    synonyms: cleaned.synonyms,
    cleanedBy: cleaned.cleanedBy,
    rawEventCount: events.length,
    trail: cleaned.trail.map((s, i) => ({ n: i + 1, ...s })),
    // Labels and fingerprints only (never typed values); kept for debugging cleanup.
    rawEvents: events,
  };
  await saveWorkflow(wf, await embed(workflowText(wf)).catch(() => null));
  announce(wf, "recorded");
  console.log(`[record] ${wf.id}: ${events.length} events → ${wf.trail.length} steps (${wf.cleanedBy})`);
  res.json({ ...wf, guideUrl: guideUrl(wf.id) });
});

// ── Explore mode: N Claude agents race to discover a path to a goal ─────────
app.post("/explore", async (req, res) => {
  const { goal, url, agents } = req.body || {};
  if (!goal || !url) return res.status(400).json({ error: "need goal and url" });
  if (String(goal).length > 300) return res.status(400).json({ error: "goal is too long" });
  let parsed;
  try { parsed = new URL(String(url)); } catch { return res.status(400).json({ error: "start URL must be a full http(s) address" }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: "start URL must be http or https" });
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)) return res.status(400).json({ error: "that is the bridge itself, not a site to explore" });
  try {
    const ex = await startExploration({ goal, url, agents: Number(agents) || config.exploreAgents });
    res.json(ex);
  } catch (err) {
    console.error("[explore]", err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// The OAuth server sends MCP clients here to sign in and approve them.
app.get("/oauth/consent", page("oauth-consent.html"));
app.get("/explore", page("explore.html"));
app.get("/explore/:id", page("explore-run.html"));

// Summary of every exploration for the history page: outcome counts, the winner, eval averages.
function summarize(ex) {
  const outcomes = {};
  for (const a of ex.agents) outcomes[a.outcome || a.status] = (outcomes[a.outcome || a.status] || 0) + 1;
  const evals = {};
  for (const a of ex.agents) for (const e of a.evals || []) {
    const v = e.rating != null ? e.rating : e.passed === true ? 1 : e.passed === false ? 0 : null;
    if (v == null) continue;
    (evals[e.slug] ||= []).push(v);
  }
  const avg = (xs) => Math.round((xs.reduce((n, x) => n + x, 0) / xs.length) * 10) / 10;
  const win = ex.winner ? ex.agents[ex.winner.agent] : null;
  return {
    id: ex.id, goal: ex.goal, url: ex.url, site: (() => { try { return new URL(ex.url).hostname.replace(/^www\./, ""); } catch { return ex.url; } })(),
    status: ex.status, startedAt: ex.startedAt, finishedAt: ex.finishedAt || null,
    seconds: ex.finishedAt ? Math.round((new Date(ex.finishedAt) - new Date(ex.startedAt)) / 1000) : null,
    agents: ex.agents.length, outcomes,
    winner: ex.winner ? { agent: ex.winner.agent, workflowId: ex.winner.workflowId, steps: win?.steps ?? null } : null,
    evals: Object.fromEntries(Object.entries(evals).map(([k, xs]) => [k, { avg: avg(xs), n: xs.length }])),
  };
}

app.get("/explorations", async (_req, res) => res.json((await listExplorations()).map(summarize)));
app.get("/history", page("history.html"));
app.get("/explorations/:id", async (req, res) => {
  const ex = await getExploration(req.params.id);
  ex ? res.json(ex) : res.status(404).json({ error: "not found" });
});

// ── Library ─────────────────────────────────────────────────────────────────
app.get("/workflows", async (req, res) => {
  const site = String(req.query.site || "").replace(/^www\./, "");
  const q = String(req.query.q || "").toLowerCase();
  const list = (await listWorkflows())
    .filter((wf) => !site || String(wf.site).replace(/^www\./, "") === site)
    .filter((wf) => !q || `${wf.task} ${wf.synonyms}`.toLowerCase().includes(q))
    .map((wf) => ({ id: wf.id, task: wf.task, site: wf.site, taughtBy: wf.taughtBy || "human", recordedBy: wf.recordedBy, recordedAt: wf.recordedAt, steps: wf.trail.length, guideUrl: guideUrl(wf.id) }));
  res.json(list);
});

app.get("/workflows/:id", async (req, res) => {
  const wf = await getWorkflow(req.params.id);
  wf ? res.json(wf) : res.status(404).json({ error: "not found" });
});

// ── Ask room: people and agents ask; Corgi Brain answers from the library ────
app.post("/ask", async (req, res) => {
  const { question, author, authorKind } = req.body || {};
  try { res.json(await ask({ question, author, authorKind })); }
  catch (err) { console.error("[ask]", err.message); res.status(err.status || 502).json({ error: err.message }); }
});
app.post("/ask/request", async (req, res) => {
  const { task, author } = req.body || {};
  if (!task) return res.status(400).json({ error: "need task" });
  try { res.json(await requestRecording({ task, author })); }
  catch (err) { res.status(502).json({ error: err.message }); }
});
const askTemplate = readFileSync(join(BRIDGE_DIR, "public", "ask.html"), "utf8");
app.get("/ask", (_req, res) => res.type("html").send(askTemplate.replaceAll("{{NAV}}", () => nav("ask"))));

// ── Brain keeper: an Agent37 agent on a schedule checks every workflow and reports back ──
const keeperOk = (req) => !config.keeperToken || req.get("x-keeper-token") === config.keeperToken;
app.post("/maintenance/check-all", async (req, res) => {
  if (!keeperOk(req)) return res.status(401).json({ error: "missing or wrong x-keeper-token" });
  try { res.json(await checkAll({ limit: Number(req.query.limit) || 20 })); }
  catch (err) { console.error("[keeper]", err.message); res.status(502).json({ error: err.message }); }
});
app.post("/maintenance/report", async (req, res) => {
  if (!keeperOk(req)) return res.status(401).json({ error: "missing or wrong x-keeper-token" });
  const { text, stats } = req.body || {};
  if (!text) return res.status(400).json({ error: "need text" });
  try { res.json(await postReport(text, stats ? { stats } : {})); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Replay: run a saved workflow for an agent, healing it if the site changed ──
app.post("/workflows/:id/run", async (req, res) => {
  const { inputs, heal, caller } = req.body || {};
  try { res.json(await replayWorkflow(req.params.id, { inputs: inputs || {}, heal: heal !== false, caller: String(caller || "api").slice(0, 40) })); }
  catch (err) { console.error("[replay]", err.message); res.status(err.status || 502).json({ error: err.message }); }
});

const replaysTemplate = readFileSync(join(BRIDGE_DIR, "public", "replays.html"), "utf8");
app.get("/replays", (req, res) => res.type("html").send(replaysTemplate.replaceAll("{{NAV}}", () => nav("replays")).replaceAll("{{BASE}}", () => esc(`${req.protocol}://${req.get("host")}`))));

app.get("/replays.json", async (_req, res) => {
  const { data, error } = await db.from("replays").select("id, workflow_id, caller, ok, seconds, failed_at, reason, healed, saved_seconds, saved_usd, at").order("at", { ascending: false }).limit(50);
  if (error) return res.status(502).json({ error: error.message });
  res.json({ stats: await replayStats(), replays: data });
});

// "Add to Claude as a Skill": the workflow as a Claude Agent Skill (.zip with SKILL.md).
app.get("/workflows/:id/skill.zip", async (req, res) => {
  const wf = await getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: "not found" });
  const { filename, buffer } = skillZip(wf, { guideUrl: guideUrl(wf.id) });
  res.set({ "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"` }).send(buffer);
});
app.get("/workflows/:id/skill.md", async (req, res) => {
  const wf = await getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: "not found" });
  res.type("text/markdown").send(skillMarkdown(wf, { guideUrl: guideUrl(wf.id) }));
});

app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "missing q" });
  const hit = await findWorkflow(q);
  res.json(hit ? summary(hit.wf, hit.source) : { found: false, query: q });
});

// Several ranked matches, for the library search box and the MCP server.
app.get("/search/all", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "missing q" });
  const by = ["human", "agent"].includes(req.query.by) ? req.query.by : null;
  const n = Number(req.query.n) || 5;
  try {
    const hits = (await searchLibrary(q, by ? n * 3 : n)).filter(({ wf }) => !by || (wf.taughtBy || "human") === by).slice(0, n);
    res.json(hits.map(({ wf, score }) => ({ ...summary(wf), score })));
  }
  catch (err) { res.status(502).json({ error: err.message }); }
});

const EVAL_LABEL = { "reached-goal": "goal", "clean-instructions": "instructions", "no-wasted-actions": "directness" };
// Judge chips for an agent-discovered workflow: the winning agent's verdicts, the race's cost,
// and a link back to the race.
function judgeChips(wf, ex) {
  if (!ex) return "";
  const winner = ex.winner ? ex.agents[ex.winner.agent] : null;
  const evals = winner?.evals || [];
  const cost = ex.cost ? `<span class="ev" title="Claude tokens spent by every agent and the judge">race cost $${Number(ex.cost).toFixed(2)}</span>` : "";
  const watch = `<a class="ev link" href="/explore/${esc(ex.id)}">watch the race</a>`;
  if (!evals.length) return `<div class="judge">${ex.status === "running" || ex.status === "judging" ? '<span class="ev pending" title="Claude judges each run after the race">judging…</span>' : ""}${cost}${watch}</div>`;
  return `<div class="judge">${evals.map((e) => {
    const name = EVAL_LABEL[e.slug] || e.slug;
    const val = e.rating != null ? `${e.rating}/5` : e.passed === true ? "✓" : e.passed === false ? "✗" : "?";
    const cls = e.rating != null ? (e.rating >= 4 ? "pass" : e.rating <= 2 ? "fail" : "") : e.passed ? "pass" : e.passed === false ? "fail" : "";
    return `<span class="ev ${cls}" title="${esc(e.reasoning || "")}">${esc(name)} ${val}</span>`;
  }).join("")}${cost}${watch}</div>`;
}

// Recorded (taught by people) and Discovered (found by agents) are separate pages on one template.
const PAGES = {
  human: {
    path: "/recorded", title: "Recorded", kicker: "Recorded by your team",
    h1: "How your team does it",
    lede: "Workflows teammates recorded with the extension. Claude keeps the shortest path and drops accidental clicks. Pick one and Guide me walks you through it in your own browser.",
    cta: `<div class="cta light"><div><h2>Teach one</h2><p>Open the site, click <b>● Record</b> in the Corgi Brain extension, and do the task once. Labels and fingerprints only; typed values never leave your browser.</p></div><a class="btn secondary" href="/discovered">See what agents found</a></div>`,
    placeholder: "Search recordings: how do I send back something I bought?",
    empty: "Nothing recorded yet. Click ● Record in the extension and do a task once.",
  },
  agent: {
    path: "/discovered", title: "Discovered", kicker: "Discovered by agents",
    h1: "What the agents found",
    lede: "Paths Claude agents discovered by racing each other through public sites. Claude Opus judged every run from its screenshots before it landed here.",
    cta: `<div class="cta"><div><h2>Nobody knows the way yet?</h2><p>Send several Claude agents to a public site with a goal. Watch them race live; the shortest path the judge agrees with lands here.</p></div><a class="btn" href="/explore">Explore a site</a></div>`,
    placeholder: "Search discoveries: how big is each nation?",
    empty: "No discoveries yet. Explore a site and the winning path lands here.",
  },
};

const nav = (on) => {
  const a = (href, key, label) => `<a href="${href}"${on === key ? ' class="on" aria-current="page"' : ""}>${label}</a>`;
  return `<nav class="nav">
    <a class="brand" href="/ask" aria-label="Corgi Brain"><img src="/assets/logo/corgibrain-wordmark.svg" alt="Corgi Brain"></a>
    ${a("/ask", "ask", "Ask")}
    ${a("/recorded", "recorded", "Recorded")}
    <span class="nav-sep" aria-hidden="true"></span>
    <span class="nav-group">Agents</span>
    ${a("/discovered", "discovered", "Discovered")}
    ${a("/explore", "explore", "Explore")}
    ${a("/replays", "replays", "Replays")}
    ${a("/history", "history", "History")}
  </nav>`;
};

const libraryTemplate = readFileSync(join(BRIDGE_DIR, "public", "library.html"), "utf8");
async function libraryPage(by, res) {
  const page = PAGES[by];
  const [stats, everything] = await Promise.all([guidedRunStats(), listWorkflows()]);
  const all = everything.filter((wf) => (wf.taughtBy || "human") === by);
  const races = by === "agent" ? await listExplorations() : [];
  const rs = await replayStats();
  const raceById = new Map(races.map((ex) => [ex.id, ex]));
  const runs = all.reduce((n, wf) => n + (stats[wf.id]?.completed || 0), 0);
  const cards = all.map((wf) => {
    const s = stats[wf.id];
    const used = s?.completed ? `Used ${s.completed}× by ${[...s.people].join(", ")}` : "Not used yet";
    const who = by === "agent" ? `Discovered by ${wf.agentCount === 1 ? "1 agent" : `${esc(wf.agentCount || "several")} agents`}` : `Recorded by ${esc(wf.recordedBy)}`;
    const cleaned = wf.rawEventCount ? ` <span class="tag" title="Claude dropped accidental clicks and detours">cleaned from ${esc(wf.rawEventCount)} actions</span>` : "";
    const steps = wf.trail.map((t) => `<li>${esc(t.instruction)}${t.secret ? ' <span class="tag">stays in your browser</span>' : ""}</li>`).join("");
    return `<article class="card" data-id="${esc(wf.id)}" data-site="${esc(wf.site)}">
  <div class="top"><span class="site">${esc(wf.site)}</span><span class="used">${esc(used)}</span></div>
  <h2>${esc(wf.task)}</h2>
  <div class="meta">${who} on ${esc(String(wf.recordedAt).slice(0, 10))} · ${wf.trail.length} steps${cleaned}</div>
  <details><summary>Show steps</summary><ol>${steps}</ol></details>
  ${by === "agent" ? judgeChips(wf, raceById.get(wf.explorationId)) : ""}
  <div class="go acts"><a class="btn secondary" href="/guide/${esc(wf.id)}">Guide me</a><a class="skill" href="/workflows/${esc(wf.id)}/skill.zip" download title="Download as a Claude Agent Skill (SKILL.md) for Claude.ai or Claude Code">Add to Claude as a Skill</a></div>
</article>`;
  }).join("\n");
  const statsHtml = by === "agent"
    ? `<div><b>${all.length}</b><span>discovered workflows</span></div><div><b>${races.length}</b><span>races run</span></div><div><b>$${races.reduce((n, ex) => n + (Number(ex.cost) || 0), 0).toFixed(2)}</b><span>spent by agents</span></div><div><b>${runs}</b><span>guided runs completed</span></div><div><b>${rs.replays}</b><span><a href="/replays">agent replays</a>, ${Math.round(rs.savedSeconds / 60)} min saved</span></div>`
    : `<div><b>${all.length}</b><span>recorded workflows</span></div><div><b>${new Set(all.map((w) => w.recordedBy)).size}</b><span>teammates recorded</span></div><div><b>${runs}</b><span>guided runs completed</span></div>`;
  // The most-used sites get pills; the rest go in a dropdown so the row never overflows.
  const siteCounts = {};
  for (const wf of all) siteCounts[wf.site] = (siteCounts[wf.site] || 0) + 1;
  const sites = Object.keys(siteCounts).sort((x, y) => siteCounts[y] - siteCounts[x] || x.localeCompare(y));
  const PILLS = Number(process.env.SITE_PILLS) || 6;
  const more = sites.slice(PILLS).sort();
  const filters = sites.length > 1 ? [
    '<button type="button" class="f on" data-f="" aria-pressed="true">All sites</button>',
    ...sites.slice(0, PILLS).map((s) => `<button type="button" class="f" data-f="${esc(s)}" aria-pressed="false">${esc(s)} <span class="n">${siteCounts[s]}</span></button>`),
    more.length ? `<select class="f more" id="more-sites" aria-label="More sites"><option value="">${more.length} more site${more.length === 1 ? "" : "s"}…</option>${more.map((s) => `<option value="${esc(s)}">${esc(s)} (${siteCounts[s]})</option>`).join("")}</select>` : "",
  ].join("") : "";
  res.type("html").send(
    libraryTemplate
      .replaceAll("{{NAV}}", () => nav(by === "agent" ? "discovered" : "recorded"))
      .replaceAll("{{BY}}", () => by)
      .replaceAll("{{TITLE}}", () => page.title)
      .replaceAll("{{KICKER}}", () => page.kicker)
      .replaceAll("{{H1}}", () => page.h1)
      .replaceAll("{{LEDE}}", () => page.lede)
      .replaceAll("{{CTA}}", () => page.cta)
      .replaceAll("{{STATS}}", () => statsHtml)
      .replaceAll("{{PLACEHOLDER}}", () => page.placeholder)
      .replaceAll("{{FILTERS}}", () => filters)
      .replaceAll("{{CARDS}}", () => cards || `<p class="empty">${page.empty}</p>`),
  );
}

app.get("/", (_req, res) => res.redirect("/ask"));
app.get("/library", (_req, res) => res.redirect("/recorded"));
app.get("/recorded", (_req, res) => libraryPage("human", res));
app.get("/discovered", (_req, res) => libraryPage("agent", res));

const guideTemplate = readFileSync(join(BRIDGE_DIR, "public", "guide.html"), "utf8");
app.get("/guide/:id", async (req, res) => {
  const wf = await getWorkflow(req.params.id);
  if (!wf) return res.status(404).send("Workflow not found.");
  const steps = wf.trail.map((s) => `<li>${esc(s.instruction)}${s.secret ? ' <span class="tag">stays in your browser</span>' : ""}</li>`).join("");
  res.type("html").send(
    guideTemplate
      .replaceAll("{{ID}}", () => esc(wf.id))
      .replaceAll("{{BACK}}", () => wf.taughtBy === "agent" ? "/discovered" : "/recorded")
      .replaceAll("{{TASK}}", () => esc(wf.task))
      .replaceAll("{{WHO}}", () => wf.taughtBy === "agent" ? `Discovered by ${esc(wf.agentCount || "several")} agents` : `Recorded by ${esc(wf.recordedBy)}`)
      .replaceAll("{{DATE}}", () => esc(String(wf.recordedAt).slice(0, 10)))
      .replaceAll("{{SITE}}", () => esc(wf.site))
      .replaceAll("{{START}}", () => esc(wf.startUrl || `https://${wf.site}`))
      .replaceAll("{{STEPS}}", () => steps),
  );
});

// A teammate finished (or stopped) a guided replay.
app.post("/runs", async (req, res) => {
  const { id, user, outcome, assists = 0, seconds } = req.body || {};
  try { await logGuidedRun({ id, user, outcome, assists, seconds }); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  console.log(`[runs] ${user} ${outcome} ${id} (${seconds}s, ${assists} assists)`);
  res.json({ ok: true });
});

app.get("/health", async (_req, res) => {
  res.json({ ok: true, anthropicKey: Boolean(config.anthropicKey), supabase: config.supabaseUrl, model: config.model, judgeModel: config.judgeModel, workflows: (await listWorkflows()).length });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`[corgi-brain] bridge on http://localhost:${config.port} (model ${config.model}, judge ${config.judgeModel}, anthropic key ${config.anthropicKey ? "loaded" : "MISSING"})`);
});
