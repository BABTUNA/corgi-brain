// Explore mode: race N Claude explorer agents, each with its own browser and strategy, toward a
// goal on a public site. Every step is saved as it happens (the race page listens
// through Realtime); afterwards a judge model scores each run, and the shortest path the judge
// agrees reached the goal is saved to the library.
import { config } from "./config.js";
import { runExplorer } from "./explorer.js";
import { judgeAgent } from "./judge.js";
import { saveExploration, flushExploration, getExploration, saveWorkflow, uniqueId, slugify } from "./store.js";
import { embed, workflowText } from "./embed.js";
import { rankTrails } from "./trail.js";
import { announce } from "./ask.js";

const STRATEGIES = [
  "Prefer the site's primary navigation and menus.",
  "Prefer the site search box first, then refine.",
  "Prefer links whose text closely matches the goal wording.",
  "Prefer footer and sitemap links.",
  "Explore breadth-first: open the two most promising links before committing.",
  "Prefer the most specific deep link you can see on the current page.",
];

const round = (n) => Math.round(n * 10000) / 10000;

export async function startExploration({ goal, url, agents }) {
  const n = Math.max(1, Math.min(agents || config.exploreAgents, STRATEGIES.length));
  const ex = {
    id: `${slugify(goal).slice(0, 48)}-${Date.now().toString(36)}`,
    goal, url, mode: "claude", model: config.model, judgeModel: config.judgeModel,
    status: "running", startedAt: new Date().toISOString(), winner: null, cost: 0,
    agents: STRATEGIES.slice(0, n).map((strategy, i) => ({ i, strategy, status: "queued", outcome: null, steps: null, deadEnds: null, trail: null })),
  };
  const save = () => { ex.cost = round(ex.agents.reduce((s, a) => s + (a.cost || 0), 0)); saveExploration(ex); };
  save();
  await flushExploration(ex.id);

  (async () => {
    await Promise.all(ex.agents.map((a) => runExplorer({ ex, a, save }).catch((err) => {
      Object.assign(a, { status: "error", outcome: "error", error: err.message });
      save();
    })));

    ex.status = "judging"; save();
    await Promise.all(ex.agents.filter((a) => a.trail?.length || a.outcome === "reached").map((a) =>
      judgeAgent(ex, a).catch((err) => console.warn(`[judge] agent ${a.i}: ${err.message}`)).finally(save)));

    // A run wins only if the agent says it reached the goal and the judge agrees (or could not judge).
    const ranked = rankTrails(ex.agents.filter((a) => a.outcome === "reached" && a.judgeSays !== false));
    if (ranked.length) {
      const best = ranked[0];
      const wf = {
        id: await uniqueId(goal),
        task: goal[0].toUpperCase() + goal.slice(1),
        site: new URL(url).hostname.replace(/^www\./, ""),
        startUrl: url,
        taughtBy: "agent",
        agentCount: ex.agents.length,
        explorationId: ex.id,
        recordedBy: `agent-${best.i + 1}`,
        recordedAt: new Date().toISOString(),
        synonyms: "",
        cleanedBy: config.model,
        trail: best.trail.map((s, i) => ({ n: i + 1, ...s })),
      };
      await saveWorkflow(wf, await embed(workflowText(wf)).catch(() => null));
      announce(wf, "discovered");
      ex.winner = { agent: best.i, workflowId: wf.id };
      ex.status = "done";
    } else {
      ex.status = ex.agents.some((a) => a.outcome === "login_required") ? "login_required"
        : ex.agents.some((a) => a.outcome === "blocked") && ex.agents.every((a) => ["blocked", "error"].includes(a.outcome)) ? "blocked"
        : "failed";
    }
    ex.finishedAt = new Date().toISOString();
    save();
    await flushExploration(ex.id);
    console.log(`[explore] ${ex.id}: ${ex.status}${ex.winner ? ` → ${ex.winner.workflowId}` : ""} ($${ex.cost})`);
  })().catch((err) => { console.error("[explore]", err); ex.status = "failed"; ex.error = err.message; save(); });

  return ex;
}

export { getExploration };
