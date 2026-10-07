// Replays a saved workflow in a headless browser for an agent: no model calls, so a known path
// costs nothing and takes seconds. Each step's element is found again by fingerprint, then by
// tag and text. If a step no longer matches (the site changed), the workflow heals itself: one
// Claude explorer continues from the broken step, Claude Opus checks the result, and the
// repaired path replaces the old one in the library.
import { getBrowser, elements, pathOf, runExplorer } from "./explorer.js";
import { judgeAgent } from "./judge.js";
import { db, saveWorkflow, getWorkflow, getExploration, listExplorations } from "./store.js";
import { embed, workflowText } from "./embed.js";
import { announce } from "./ask.js";

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

function findElement(els, step) {
  if (step.fid) {
    const byFid = els.find((e) => e.fid === step.fid);
    if (byFid) return { el: byFid, how: "fingerprint" };
  }
  const want = norm(step.target?.text || step.label || step.field);
  const tag = step.target?.tag;
  if (want) {
    const exact = els.find((e) => norm(e.text) === want && (!tag || e.tag === tag));
    if (exact) return { el: exact, how: "text" };
    // Only accept elements whose text contains the recorded text, never the other way round:
    // "Python Docs Classic" must not match a link that just says "Python".
    const loose = els.find((e) => norm(e.text).includes(want) && (!tag || e.tag === tag));
    if (loose) return { el: loose, how: "partial text" };
  }
  if (step.kind === "fill" && step.field) {
    const field = els.find((e) => e.field && norm(e.field).includes(norm(step.field)));
    if (field) return { el: field, how: "field label" };
  }
  return null;
}

const settle = async (page) => {
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
};

/** Runs the trail. Returns { ok, steps, failedAt, reason, finalUrl, title, text, page, context }. */
async function walk(wf, inputs = {}) {
  const context = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const steps = [];
  let failedAt = null, reason = null;
  try {
    await page.goto(wf.startUrl || `https://${wf.site}`, { waitUntil: "domcontentloaded", timeout: 25000 });
    await settle(page);
    for (const step of wf.trail) {
      const n = step.n ?? steps.length + 1;
      if (step.kind === "verify") {
        const text = step.textIncludes ? await page.evaluate("document.body.innerText").catch(() => "") : "";
        const ok = !step.textIncludes || norm(text).includes(norm(step.textIncludes));
        steps.push({ n, kind: step.kind, instruction: step.instruction, status: ok ? "ok" : "unverified" });
        continue;
      }
      if (step.kind === "nav") {
        await page.goto(step.href, { waitUntil: "domcontentloaded", timeout: 25000 });
        await settle(page);
        steps.push({ n, kind: step.kind, instruction: step.instruction, status: "ok", how: "url" });
        continue;
      }
      const value = step.kind === "fill" ? (inputs[n] ?? inputs[step.field] ?? step.value) : undefined;
      if (step.kind === "fill" && (value == null || value === "")) {
        failedAt = n; reason = `needs input for "${step.field || step.instruction}" (pass inputs: {"${n}": "..."})`;
        steps.push({ n, kind: step.kind, instruction: step.instruction, status: "needs input" });
        break;
      }
      const found = findElement(await elements(page), step);
      if (!found) {
        failedAt = n; reason = `element not found: ${step.target?.text || step.field || step.instruction}`;
        steps.push({ n, kind: step.kind, instruction: step.instruction, status: "not found" });
        break;
      }
      const loc = page.locator(`[data-bb-idx="${found.el.idx}"]`).first();
      try {
        if (step.kind === "fill") { await loc.fill(String(value)); await page.keyboard.press("Enter").catch(() => {}); }
        else if (step.kind === "select") await loc.selectOption({ label: String(value ?? step.option ?? "") });
        else await loc.click({ timeout: 8000 });
      } catch (err) {
        failedAt = n; reason = `could not ${step.kind}: ${String(err.message).split("\n")[0]}`;
        steps.push({ n, kind: step.kind, instruction: step.instruction, status: "failed", how: found.how });
        break;
      }
      await settle(page);
      steps.push({ n, kind: step.kind, instruction: step.instruction, status: "ok", how: found.how, urlAfter: pathOf(page.url()) });
    }
  } catch (err) {
    failedAt ??= steps.length + 1; reason ??= String(err.message).split("\n")[0];
  }
  const title = await page.title().catch(() => "");
  const text = (await page.evaluate("document.body.innerText").catch(() => "")).replace(/\s+/g, " ").slice(0, 1500);
  return { ok: failedAt == null, steps, failedAt, reason, finalUrl: page.url(), title, text, page, context };
}

// What exploring from scratch costs, for the "saved" numbers: the race that found this path, or
// the average race when the path was recorded by a person.
async function baseline(wf) {
  const secs = (ex) => ex?.finishedAt ? (new Date(ex.finishedAt) - new Date(ex.startedAt)) / 1000 : null;
  if (wf.explorationId) {
    const ex = await getExploration(wf.explorationId);
    if (ex?.finishedAt && ex.cost) return { seconds: secs(ex), usd: Number(ex.cost) };
  }
  const done = (await listExplorations()).filter((ex) => ex.status === "done" && ex.finishedAt && ex.cost);
  if (!done.length) return { seconds: 60, usd: 0.1 };
  return { seconds: done.reduce((n, ex) => n + secs(ex), 0) / done.length, usd: done.reduce((n, ex) => n + Number(ex.cost), 0) / done.length };
}

/** Continue from where the path broke with one explorer agent; keep the repair if the judge agrees. */
async function heal(wf, broken) {
  const keep = wf.trail.filter((s) => (s.n ?? 0) < broken.failedAt && s.kind !== "verify");
  const failedStep = wf.trail.find((s) => s.n === broken.failedAt);
  const ex = {
    id: `heal-${wf.id}-${Date.now().toString(36)}`,
    goal: wf.task.replace(/^./, (c) => c.toLowerCase()),
    url: broken.finalUrl,
    note: `A saved path for this goal broke here. The steps before this page still work. The step that broke was: "${failedStep?.instruction || "unknown"}". Continue from this page to the goal.`,
  };
  const a = { i: 0, strategy: "Repair a broken path: find what replaced the missing element, or another way to the goal." };
  await runExplorer({ ex, a, save: () => {} });
  if (a.outcome !== "reached") return { healed: false, cost: a.cost || 0, reason: `repair agent ${a.outcome}` };
  await judgeAgent(ex, a).catch(() => {});
  if (a.judgeSays === false) return { healed: false, cost: a.cost || 0, reason: "judge rejected the repair" };
  const trail = [...keep, ...a.trail].map((s, i) => ({ ...s, n: i + 1 }));
  const revisions = [...(wf.revisions || []), { at: new Date().toISOString(), brokeAt: broken.failedAt, reason: broken.reason, previous: wf.trail }].slice(-5);
  const healed = { ...wf, trail, revisions, healedAt: new Date().toISOString(), healCount: (wf.healCount || 0) + 1 };
  await saveWorkflow(healed, await embed(workflowText(healed)).catch(() => null));
  announce(healed, "healed");
  return { healed: true, cost: a.cost || 0, workflow: healed, frames: a.frames?.map((f) => f.src) || [] };
}

export async function replayWorkflow(id, { inputs = {}, heal: allowHeal = true, caller = "api" } = {}) {
  const wf = await getWorkflow(id);
  if (!wf) { const e = new Error("workflow not found"); e.status = 404; throw e; }
  const t0 = Date.now();
  let run = await walk(wf, inputs);
  let healInfo = null;
  if (!run.ok && allowHeal && !/^needs input/.test(run.reason || "")) {
    await run.context.close().catch(() => {});
    healInfo = await heal(wf, run);
    if (healInfo.healed) run = await walk(healInfo.workflow, inputs);
  }
  await run.context.close().catch(() => {});
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const base = await baseline(wf);
  const healCost = Math.round((healInfo?.cost || 0) * 10000) / 10000;
  const saved = run.ok ? { seconds: Math.max(0, Math.round(base.seconds - seconds)), usd: Math.max(0, Math.round((base.usd - healCost) * 10000) / 10000) } : { seconds: 0, usd: 0 };
  const result = {
    workflowId: wf.id, task: wf.task, ok: run.ok, seconds, costUsd: healCost,
    saved, baseline: { seconds: Math.round(base.seconds), usd: Math.round(base.usd * 10000) / 10000 },
    healed: Boolean(healInfo?.healed), ...(healInfo && !healInfo.healed ? { healFailed: healInfo.reason } : {}),
    failedAt: run.failedAt, reason: run.reason,
    finalUrl: run.finalUrl, title: run.title, pageText: run.text,
    steps: run.steps,
  };
  const { error } = await db.from("replays").insert({
    workflow_id: wf.id, caller, ok: run.ok, seconds, failed_at: run.failedAt, reason: run.reason,
    healed: result.healed, heal_cost_usd: healCost, saved_seconds: saved.seconds, saved_usd: saved.usd, steps: run.steps,
  });
  if (error) console.warn("[replay] log:", error.message);
  console.log(`[replay] ${wf.id}: ${run.ok ? "ok" : `failed at ${run.failedAt}`}${result.healed ? " (healed)" : ""} in ${seconds}s, saved ${saved.seconds}s $${saved.usd}`);
  return result;
}

export async function replayStats() {
  const { data, error } = await db.from("replays").select("ok, healed, saved_seconds, saved_usd");
  if (error) return { replays: 0, ok: 0, healed: 0, savedSeconds: 0, savedUsd: 0 };
  return {
    replays: data.length,
    ok: data.filter((r) => r.ok).length,
    healed: data.filter((r) => r.healed).length,
    savedSeconds: Math.round(data.reduce((n, r) => n + Number(r.saved_seconds), 0)),
    savedUsd: Math.round(data.reduce((n, r) => n + Number(r.saved_usd), 0) * 100) / 100,
  };
}
