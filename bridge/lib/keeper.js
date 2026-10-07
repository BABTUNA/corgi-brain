// The brain keeper's side of Corgi Brain: check every workflow that runs without a login, let
// broken ones heal, and accept the keeper agent's report for the Ask room. The keeper itself is an
// Agent37 agent on a schedule (scripts/keeper-setup.js); these are the two endpoints it calls.
import { listWorkflows } from "./store.js";
import { replayWorkflow } from "./replay.js";
import { postMessage } from "./ask.js";

// Workflows a teammate recorded in their own signed-in session can't be replayed by an agent
// without their login, so the keeper only checks the ones agents discovered on public sites.
const checkable = (wf) => wf.taughtBy === "agent" && wf.startUrl;

let running = null;

export async function checkAll({ limit = 20 } = {}) {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    const all = await listWorkflows();
    const todo = all.filter(checkable).slice(0, limit);
    const results = [];
    for (const wf of todo) {
      try {
        const r = await replayWorkflow(wf.id, { caller: "brain keeper (Agent37)" });
        results.push({ id: wf.id, task: wf.task, site: wf.site, ok: r.ok, healed: r.healed, seconds: r.seconds, reason: r.ok ? null : r.reason });
      } catch (err) {
        results.push({ id: wf.id, task: wf.task, site: wf.site, ok: false, healed: false, reason: err.message });
      }
    }
    return {
      checked: results.length,
      ok: results.filter((r) => r.ok && !r.healed).length,
      healed: results.filter((r) => r.healed && r.ok).length,
      broken: results.filter((r) => !r.ok).length,
      skippedNeedsLogin: all.length - all.filter(checkable).length,
      seconds: Math.round((Date.now() - t0) / 1000),
      results,
    };
  })().finally(() => { running = null; });
  return running;
}

export async function postReport(text, meta = {}) {
  return postMessage({
    kind: "announcement",
    author: "Brain keeper (Agent37)",
    author_kind: "agent",
    body: String(text).slice(0, 1200),
    meta: { what: "keeper", ...meta },
  });
}
