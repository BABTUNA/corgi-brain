// Turns a raw recording into a clean, reusable trail. Claude decides which raw
// events to keep and writes the instructions; the recorded element fingerprints
// are copied over untouched so replay can find the same elements again.
import { askJson } from "./claude.js";

const SYSTEM = `You turn a raw recording of a person using a website into a short, reusable step list for teammates.

Input: the task the person said they were doing, and an ordered list of raw events (index i, kind, label/field, url, secret flag, optional page text).

Return ONLY JSON:
{"task": "<clean task title, <= 8 words>",
 "synonyms": "<comma list of other ways people would ask for this task>",
 "keep": [{"i": <raw index>, "instruction": "<one imperative sentence>"}],
 "verify": {"instruction": "<how the person knows it worked>", "textIncludes": "<short text that appears on the page when done, or empty>"}}

Rules:
- Keep the shortest sequence of steps that still completes the task. People click extra things by accident; the guide must not repeat them.
- Drop wrong turns: a click followed by navigating back or away without progress, a click that led nowhere, repeated clicks on the same thing.
- Drop accidental clicks: opening a menu and closing it again without choosing anything, clicks on plain text or empty space, tabs or panels opened and abandoned, anything that did not move the person toward the task.
- The recording covers the WHOLE task. Keep every meaningful step through the final save/submit click; never stop early at an intermediate page.
- Drop "nav" events; navigation happens as a result of clicks.
- Keep each "fill" and "select" once per field, in order.
- Never include typed values. For secret fields write "Paste your <field> (it stays in your browser)."
- Write each instruction as one short imperative sentence a new hire understands. Mention where the element is if the label is ambiguous.
- Do not mention usernames, repository names or ids in instructions.
- If the recording ends before a final save/submit click, the verify step describes where the person ended up (e.g. "You are on the New secret form with the fields filled in"), not a result that never happened.
- For verify, prefer text from the last pageText event (e.g. a success message). textIncludes should be a short, stable phrase (for example the secret list heading), never a typed value.`;

function eventLine(e, i) {
  const bits = [`i=${i}`, `kind=${e.kind}`];
  if (e.label) bits.push(`label="${e.label}"`);
  if (e.field) bits.push(`field="${e.field}"`);
  if (e.option) bits.push(`option="${e.option}"`);
  if (e.secret) bits.push("secret=true");
  if (e.url) bits.push(`url=${e.url}`);
  if (e.sample) bits.push(`pageText="${String(e.sample).slice(0, 120)}"`);
  return bits.join(" ");
}

function toStep(e, instruction) {
  const step = { kind: e.kind === "click" ? "click" : e.kind, instruction };
  if (e.target) step.target = e.target;
  if (e.fid) step.fid = e.fid;
  if (e.label) step.label = e.label;
  if (e.field) step.field = e.field;
  if (e.option) step.option = e.option;
  if (e.secret) step.secret = true;
  if (e.url) step.url = e.url;
  return step;
}

function fallbackTrail(events, task) {
  const trail = events
    .filter((e) => ["click", "fill", "select"].includes(e.kind))
    .map((e) => toStep(e, e.kind === "click" ? `Click "${e.label || "this"}".` : `Fill in "${e.field || e.label || "this field"}".`));
  return { task: task || "Recorded workflow", synonyms: "", trail };
}

export async function cleanRecording({ task, events }) {
  const usable = events.filter((e) => e && e.kind);
  try {
    const { json } = await askJson({
      system: SYSTEM,
      maxTokens: 2000,
      content: `Task: ${task || "(not given)"}\n\nRaw events:\n${usable.map(eventLine).join("\n")}`,
    });
    const out = json();
    const trail = [];
    for (const k of out.keep || []) {
      const e = usable[k.i];
      if (!e || !["click", "fill", "select"].includes(e.kind)) continue;
      trail.push(toStep(e, k.instruction));
    }
    if (!trail.length) throw new Error("cleanup kept no steps");
    if (out.verify?.instruction) {
      trail.push({ kind: "verify", instruction: out.verify.instruction, textIncludes: out.verify.textIncludes || "" });
    }
    return { task: out.task || task, synonyms: out.synonyms || "", trail, cleanedBy: "claude" };
  } catch (err) {
    console.warn("[cleanup] falling back to raw steps:", err.message);
    return { ...fallbackTrail(usable, task), cleanedBy: "fallback" };
  }
}
