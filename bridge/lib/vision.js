// Port of functions/vision-pick (InsForge + OpenRouter) to a direct Anthropic call.
import { askJson } from "./claude.js";

const VISION_SYSTEM_BASE = `You guide users through web UIs.

You will receive a screenshot of the user's current browser tab and a JSON
list of interactive elements visible in the viewport. Each element has an
\`idx\`, \`tag\`, \`text\`, \`aria\`, \`testid\`, \`role\`, \`fid\` (fingerprint), and \`bbox\`.

The \`fid\` field is a stable element fingerprint that survives DOM reshuffles.
It uses one of these formats:
- \`tid:<data-testid>\` — from the element's data-testid attribute
- \`id:<stable-id>\` — from a stable HTML id
- \`fp:<tag>:<aria-or-text-and-role>\` — computed from tag + attributes

Pick the single next element the user should click to make progress on
their stated task. Prefer elements whose \`text\` or \`aria\` matches the
task intent. The screenshot is only the visible viewport — if the task
requires off-screen content, pick an element that will scroll there.

RESPONSE FORMAT — you MUST return ONLY a JSON object, no prose, no markdown:
{"idx": <number>, "fid": "<fingerprint string or null>", "instruction": "<one short imperative sentence>", "done": <boolean>}

If the task already appears complete, OR no element on the page is a
useful next step, return:
{"idx": -1, "fid": null, "instruction": "Task complete.", "done": true}

Never reply in prose. Never explain. Always return JSON.`;

const DONE_SIGNALS = [
  "task is complete", "task complete", "appears complete", "already done",
  "no further action", "no more steps", "successfully completed",
  "no actionable", "cannot determine", "unable to identify",
  "this page does not", "this page doesn't",
];

export function parseVisionJson(text) {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const p = JSON.parse(match[0]);
      if (typeof p.idx === "number") {
        return {
          idx: p.idx,
          fid: typeof p.fid === "string" ? p.fid : null,
          instruction: typeof p.instruction === "string" ? p.instruction : "Click this.",
          done: typeof p.done === "boolean" ? p.done : false,
        };
      }
    } catch { /* fall through */ }
  }
  const lower = text.toLowerCase();
  if (DONE_SIGNALS.some((s) => lower.includes(s))) {
    return { idx: -1, fid: null, done: true, instruction: "Task complete." };
  }
  throw new Error(`vision returned non-JSON: ${text.slice(0, 160)}`);
}

export async function visionPick(body) {
  const { screenshot_b64, elements, task, site_hints, step_history } = body || {};
  if (!screenshot_b64 || !Array.isArray(elements) || !task) {
    const err = new Error("missing required: screenshot_b64, elements[], task");
    err.status = 400;
    throw err;
  }
  const cleanTask = String(task).replace(/<[^>]*>/g, "").trim().slice(0, 500);
  const history = Array.isArray(step_history) ? step_history.slice(0, 10) : [];
  const system = site_hints ? `${VISION_SYSTEM_BASE}\n\n---\n\n${site_hints}` : VISION_SYSTEM_BASE;

  let historyText = "";
  if (history.length) {
    const lines = history.map((s, i) => {
      const fid = s.fid ? ` [fid: ${s.fid}]` : "";
      const el = s.elementText ? ` on "${s.elementText}"` : "";
      return `Step ${i + 1}: ${s.instruction || "click"}${el}${fid}`;
    });
    historyText = `Previous steps completed for this task:\n${lines.join("\n")}\nDo NOT repeat any step above. Pick the NEXT action.\n\n`;
  }

  const { text } = await askJson({
    system,
    maxTokens: 300,
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshot_b64 } },
      { type: "text", text: `${historyText}Task: ${cleanTask}\n\nElements (JSON):\n${JSON.stringify(elements.slice(0, 80))}` },
    ],
  });
  return parseVisionJson(text);
}
