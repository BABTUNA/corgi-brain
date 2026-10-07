// After the race, a stronger Claude model judges every finished agent from what it actually
// saw (its last screenshots) and the path it recorded, so an agent that claims success without
// reaching the goal gets caught. Verdicts use the same shape the pages render as chips.
import { claude } from "./claude.js";
import { config } from "./config.js";
import { costOf } from "./explorer.js";

const SCHEMA = {
  type: "object",
  properties: {
    reached_goal: { type: "boolean" },
    goal_reasoning: { type: "string" },
    instructions: { type: "integer", description: "1-5: can a person follow each step as written?" },
    instructions_reasoning: { type: "string" },
    directness: { type: "integer", description: "1-5: 5 means no dead ends or wasted steps." },
    directness_reasoning: { type: "string" },
  },
  required: ["reached_goal", "goal_reasoning", "instructions", "instructions_reasoning", "directness", "directness_reasoning"],
  additionalProperties: false,
};

const clamp = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 1)));

export async function judgeAgent(ex, a) {
  const shots = (a.frames || []).filter((f) => f.cmd !== "back").slice(-2);
  const steps = (a.trail || []).map((s, i) => `${i + 1}. ${s.instruction}`).join("\n") || "(no steps)";
  const content = [
    ...shots.map((f) => ({ type: "image", source: { type: "url", url: f.src } })),
    { type: "text", text: `Goal: ${ex.goal}\nStart URL: ${ex.url}\nThe agent says: ${a.outcome}${a.summary ? ` (${a.summary})` : ""}\nDead ends it backed out of: ${a.deadEnds || 0}\n\nRecorded path for a person to follow:\n${steps}\n\nThe images are the agent's last screenshots, final one last. Judge from the screenshots, not from the agent's claim.` },
  ];
  const res = await claude().messages.create({
    model: config.judgeModel,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: "You judge browser agents that try to find a path to a goal on a website. Be strict and brief: one sentence per reasoning field.",
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new Error("judge declined");
  const v = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  a.cost = Math.round(((a.cost || 0) + costOf(config.judgeModel, res.usage)) * 10000) / 10000;
  a.evals = [
    { slug: "reached-goal", passed: Boolean(v.reached_goal), rating: null, reasoning: v.goal_reasoning },
    { slug: "clean-instructions", passed: null, rating: clamp(v.instructions), reasoning: v.instructions_reasoning },
    { slug: "no-wasted-actions", passed: null, rating: clamp(v.directness), reasoning: v.directness_reasoning },
  ];
  a.judgeSays = Boolean(v.reached_goal);
}
