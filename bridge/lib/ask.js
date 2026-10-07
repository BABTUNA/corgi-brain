// The Ask room: people and agents ask how to do something in the org's web apps; Corgi Brain finds
// the team's workflows by meaning (Postgres hybrid search over gte-small vectors) and Claude answers
// from them, citing who taught each one. Every message is stored and reaches the room
// through Realtime. When nothing matches, the answer says so and offers to ask a teammate to record
// it or, for public sites, to send agents.
import { claude } from "./claude.js";
import { config } from "./config.js";
import { db } from "./store.js";
import { searchLibrary } from "./search.js";

const ROOM = "team";

const card = (wf) => ({
  id: wf.id, task: wf.task, site: wf.site, startUrl: wf.startUrl || null,
  taughtBy: wf.taughtBy || "human",
  who: wf.taughtBy === "agent" ? `discovered by ${wf.agentCount === 1 ? "an agent" : `${wf.agentCount || "several"} agents`}` : `recorded by ${wf.recordedBy || "a teammate"}`,
  steps: (wf.trail || []).map((s) => s.instruction),
  ...(wf.rawEventCount ? { cleanedFrom: wf.rawEventCount } : {}),
  ...(wf.healCount ? { healed: wf.healCount } : {}),
});

export async function postMessage(row) {
  const { data, error } = await db.from("messages").insert({ room: ROOM, ...row }).select().single();
  if (error) throw new Error(`supabase: ${error.message}`);
  return data;
}

/** Announce a new, discovered or healed workflow in the room. Never throws. */
export async function announce(wf, what) {
  const body = what === "healed"
    ? `The path for “${wf.task}” broke on ${wf.site} and healed itself. The next person or agent gets the fixed version.`
    : wf.taughtBy === "agent"
      ? `Agents discovered how to “${wf.task.replace(/^./, (c) => c.toLowerCase())}” on ${wf.site}. Claude checked it from screenshots.`
      : `${wf.recordedBy || "A teammate"} taught Corgi Brain how to “${wf.task.replace(/^./, (c) => c.toLowerCase())}” on ${wf.site}${wf.rawEventCount ? ` (cleaned from ${wf.rawEventCount} clicks to ${wf.trail.length} steps)` : ""}.`;
  await postMessage({ kind: "announcement", author: "Corgi Brain", author_kind: "brain", body, cards: [card(wf)], meta: { what } })
    .catch((err) => console.warn("[ask] announce:", err.message));
}

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Two to four short sentences for the team chat. Plain text, no markdown headings or lists." },
    cite: { type: "array", items: { type: "string" }, description: "ids of the workflows the answer relies on, best first. Empty if none fit." },
    gap: { type: "boolean", description: "true when no workflow in the library does what was asked" },
    explore: {
      type: "object",
      properties: { goal: { type: "string" }, url: { type: "string" } },
      required: ["goal", "url"],
      additionalProperties: false,
      description: "When gap is true and the task is on a public website, a goal and start URL agents could explore. Empty strings otherwise.",
    },
  },
  required: ["answer", "cite", "gap", "explore"],
  additionalProperties: false,
};

const SYSTEM = `You are Corgi Brain, the shared memory of how this team gets things done in its web apps. People and AI agents ask you in a team chat room.

Answer ONLY from the team's workflows you are given. Each one is a verified path a teammate recorded or agents discovered. Say who taught it. Do not invent steps, menus or URLs that are not in a workflow.

- If a workflow does what was asked, say so briefly, mention the key steps, and cite its id. The chat shows the full steps with Guide me and Run buttons, so do not repeat every step.
- If several fit, cite the best first.
- If none fits, set gap to true, say plainly that nobody has taught this yet, and suggest a teammate records it once with the extension. If it sounds like a task on a public website, fill explore with a goal and start URL agents could try; agents cannot log in, so leave explore empty for anything behind a login.
- Keep it short and friendly; this is a chat, not documentation.`;

export async function ask({ question, author, authorKind = "person" }) {
  const q = String(question || "").trim().slice(0, 500);
  if (!q) { const e = new Error("empty question"); e.status = 400; throw e; }
  const asked = await postMessage({ kind: "question", author: String(author || "teammate").slice(0, 40), author_kind: authorKind === "agent" ? "agent" : "person", body: q });

  // Recent room context, so follow-ups like "and on GitHub?" make sense.
  const { data: recent } = await db.from("messages").select("kind, author, body").eq("room", ROOM).in("kind", ["question", "answer"]).lt("id", asked.id).order("id", { ascending: false }).limit(4);
  const hits = await searchLibrary(q, 6).catch(() => []);
  const library = hits.map(({ wf }) => `id: ${wf.id}\ntask: ${wf.task}\nsite: ${wf.site}\ntaught: ${card(wf).who}\nalso asked as: ${wf.synonyms || "-"}\nsteps:\n${(wf.trail || []).map((s, i) => `  ${i + 1}. ${s.instruction}`).join("\n")}`).join("\n\n");
  const history = (recent || []).reverse().map((m) => `${m.kind === "answer" ? "Corgi Brain" : m.author}: ${m.body}`).join("\n");

  let out;
  try {
    const res = await claude().messages.create({
      model: config.model,
      max_tokens: 4000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `${history ? `Recent chat:\n${history}\n\n` : ""}Team workflows that might match (from search, best first):\n\n${library || "(none)"}\n\n${authorKind === "agent" ? "An AI agent" : author || "A teammate"} asks: ${q}` }],
    });
    if (res.stop_reason === "refusal") throw new Error("declined");
    out = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  } catch (err) {
    console.warn("[ask] answer:", err.message);
    out = hits.length
      ? { answer: `Here is the closest thing the team has taught: “${hits[0].wf.task}”.`, cite: [hits[0].wf.id], gap: false, explore: { goal: "", url: "" } }
      : { answer: "Nobody has taught this yet. Record it once with the extension and the whole team (and its agents) will have it.", cite: [], gap: true, explore: { goal: "", url: "" } };
  }

  const byId = new Map(hits.map(({ wf }) => [wf.id, wf]));
  const cards = out.cite.map((id) => byId.get(id)).filter(Boolean).slice(0, 3).map(card);
  const explore = out.gap && out.explore?.goal && /^https?:\/\//.test(out.explore?.url || "") ? out.explore : null;
  const answer = await postMessage({
    kind: "answer", author: "Corgi Brain", author_kind: "brain", body: out.answer, cards, reply_to: asked.id,
    meta: { gap: Boolean(out.gap) && !cards.length, explore, searched: hits.length },
  });
  return { question: asked, answer };
}

/** "Can someone record this?" — a request pinned in the room for a teammate to pick up. */
export async function requestRecording({ task, author }) {
  return postMessage({ kind: "request", author: String(author || "teammate").slice(0, 40), author_kind: "person", body: String(task || "").slice(0, 300) });
}
