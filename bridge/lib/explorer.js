// One explorer agent: Claude drives its own Playwright browser context with a handful of tools,
// and every action lands in the agent's live state (trail, screenshot, command log), which the
// caller saves so the race page updates as it happens. Steps carry the same element
// fingerprints the extension records, so a discovered trail replays without vision.
import { chromium } from "playwright";
import { claude } from "./claude.js";
import { config } from "./config.js";
import { uploadFrame } from "./store.js";

let browser = null;
export async function getBrowser() {
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ headless: process.env.HEADFUL !== "1" });
  return browser;
}

// Same rules as extension/lib/fingerprint.js, so the overlay finds these elements again.
export const PAGE_FNS = `
  const UNSTABLE = /^(:r[a-z0-9]+:|react-|turbo-|__next|radix-)/i;
  const textOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const fp = (el) => { const t = el.getAttribute("data-testid"); if (t) return "tid:" + t;
    if (el.id && !UNSTABLE.test(el.id)) return "id:" + el.id;
    const tag = el.tagName.toLowerCase(); const aria = (el.getAttribute("aria-label") || "").trim(); if (aria) return "fp:" + tag + ":" + aria;
    const text = textOf(el).slice(0, 40); const role = el.getAttribute("role") || ""; return text ? "fp:" + tag + ":" + role + ":" + text : null; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const SEL = "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],summary,label";
  const list = () => Array.from(document.querySelectorAll(SEL)).filter(visible).slice(0, 150).map((el, idx) => { el.setAttribute("data-bb-idx", String(idx)); return { idx, fid: fp(el), tag: el.tagName.toLowerCase(), text: textOf(el).slice(0, 60), href: el.getAttribute("href") || null, field: el.matches("input,select,textarea") ? (el.labels?.[0]?.innerText || el.getAttribute("placeholder") || el.name || "").trim().slice(0, 40) : null }; });
`;
export const elements = (page) => page.evaluate(`(() => { ${PAGE_FNS} return list(); })()`);
export const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const BLOCKED = /attention required|access denied|just a moment|are you a robot|captcha|verify you are human/i;

const SYSTEM = `You discover how a person would reach a goal on a public website, by driving a real browser with your tools. Your path becomes a step-by-step guide that real people will follow, so it must be short and clean.

After every action you get the page URL, its title, and its interactive elements as lines like [12] a "Pricing" -> /pricing. Use the number in brackets as idx.

Rules:
- The instruction you pass with click and fill is shown to a person being guided. Write it as a short imperative for them, e.g. "Click Downloads in the top menu" or "Type the city into the search box and press Enter". Never describe your own reasoning in it.
- If an action did not bring you closer, call back before trying something else, so the recorded path stays clean.
- Use read_text when you need to confirm what a page says.
- Never log in or create an account. If a login wall blocks the goal, call done with login_required.
- If the page says you are blocked or asks you to prove you are human, call done with blocked at once.
- When the goal is on screen, call done with reached. If you cannot get there, call done with gave_up.`;

const str = (description) => ({ type: "string", description });
const tool = (name, description, props = {}) => ({
  name, description, strict: true,
  input_schema: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false },
});
const TOOLS = [
  tool("click", "Click an element by its idx.", { idx: { type: "integer" }, instruction: str("Imperative for the person being guided.") }),
  tool("fill", "Type into a field by its idx and press Enter.", { idx: { type: "integer" }, value: str("Text to type, e.g. a search query."), instruction: str("Imperative for the person being guided.") }),
  tool("goto", "Open a URL directly. Prefer clicking: people follow clicks, not typed URLs.", { url: str("Absolute http(s) URL.") }),
  tool("back", "Go back one page; the previous step was a dead end and is removed from the path."),
  tool("read_text", "Read the visible text of the current page (first 4000 characters)."),
  tool("done", "Finish this attempt.", { outcome: { type: "string", enum: ["reached", "gave_up", "login_required", "blocked"] }, summary: str("One sentence on where you ended up.") }),
];

// Price per million tokens, for the live cost readout.
const PRICE = { "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20], "claude-haiku-4-5": [1, 5] };
export function costOf(model, usage) {
  const [i, o] = PRICE[model] || [2, 10];
  const read = usage.cache_read_input_tokens || 0, write = usage.cache_creation_input_tokens || 0;
  return ((usage.input_tokens || 0) * i + write * i * 1.25 + read * i * 0.1 + (usage.output_tokens || 0) * o) / 1e6;
}

/**
 * Runs agent `a` of exploration `ex` to completion, mutating `a` as it goes and calling save()
 * after every change. Resolves with nothing; the outcome is on `a`.
 */
export async function runExplorer({ ex, a, save }) {
  const context = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const history = [];
  Object.assign(a, { status: "running", sandboxReady: true, trail: [], steps: 0, deadEnds: 0, frames: [], trace: [], tokens: { input: 0, output: 0 }, cost: 0 });
  save();

  const shoot = async (cmd, instruction) => {
    try {
      const bytes = await page.screenshot({ type: "jpeg", quality: 55 });
      const n = String(a.frames.length + 1).padStart(2, "0");
      const src = await uploadFrame(`${ex.id}/agent-${a.i}/${n}-${cmd}.jpg`, bytes);
      a.frames.push({ src, cmd, instruction: instruction || null, url: page.url(), at: Date.now() });
    } catch (err) { console.warn(`[explorer] frame: ${err.message}`); }
  };
  const view = async () => {
    const title = await page.title().catch(() => "");
    const els = await elements(page).catch(() => []);
    a.lastElements = els;
    const lines = els.map((e) => `[${e.idx}] ${e.tag}${e.field ? ` field="${e.field}"` : ""} "${e.text}"${e.href ? ` -> ${e.href.slice(0, 80)}` : ""}`);
    const warn = BLOCKED.test(title) ? "\nWARNING: this looks like a bot-protection page. Call done with blocked." : /login|signin|sign-in|auth/i.test(page.url()) ? "\nNote: this looks like a login page." : "";
    return `URL: ${page.url()}\nTitle: ${title}${warn}\nElements:\n${lines.join("\n") || "(none)"}`;
  };
  const settle = async () => { await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(600); };
  const byIdx = (idx) => a.lastElements?.find((e) => e.idx === idx);

  async function act(name, input) {
    switch (name) {
      case "goto": {
        history.push(page.url());
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 25000 });
        await settle();
        if (a.frames.length) a.trail.push({ kind: "nav", instruction: `Go to ${input.url}`, href: input.url, url: pathOf(page.url()) });
        await shoot("goto", `Go to ${input.url}`);
        return view();
      }
      case "click": {
        const el = byIdx(input.idx);
        if (!el) return `No element with idx ${input.idx}. ${await view()}`;
        history.push(page.url());
        await page.locator(`[data-bb-idx="${el.idx}"]`).first().click({ timeout: 8000 });
        await settle();
        a.trail.push({ kind: "click", instruction: input.instruction, target: { tag: el.tag, text: (el.text || "").toLowerCase() }, fid: el.fid || undefined, url: pathOf(page.url()) });
        await shoot("click", input.instruction);
        return view();
      }
      case "fill": {
        const el = byIdx(input.idx);
        if (!el) return `No element with idx ${input.idx}. ${await view()}`;
        history.push(page.url());
        await page.locator(`[data-bb-idx="${el.idx}"]`).first().fill(input.value);
        await page.keyboard.press("Enter").catch(() => {});
        await settle();
        // Agents only type public search text, so the value is kept for replay.
        a.trail.push({ kind: "fill", instruction: input.instruction, field: el.field || el.text, fid: el.fid || undefined, input: "query", value: input.value, url: pathOf(page.url()) });
        await shoot("fill", input.instruction);
        return view();
      }
      case "back": {
        const prev = history.pop();
        if (prev) await page.goto(prev, { waitUntil: "domcontentloaded" }).catch(() => {});
        await settle();
        const dropped = a.trail.pop();
        a.deadEnds++;
        await shoot("back", dropped ? `Back: "${dropped.instruction}" was a dead end` : "Back");
        return view();
      }
      case "read_text":
        return (await page.evaluate("document.body.innerText")).replace(/\s+/g, " ").slice(0, 4000);
      default:
        return `Unknown tool ${name}.`;
    }
  }

  const messages = [{ role: "user", content: `Goal: ${ex.goal}\nStart URL: ${ex.url}\nStrategy for this attempt: ${a.strategy}\n${ex.note ? `\n${ex.note}\n` : ""}\nThe browser is open on the start URL.\n\n` }];
  try {
    await page.goto(ex.url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await settle();
    await shoot("goto", `Go to ${ex.url}`);
    messages[0].content += await view();
    save();

    let actions = 0, nudged = false;
    for (let turn = 0; turn < config.maxActions + 6; turn++) {
      const res = await claude().messages.create({
        model: config.model,
        max_tokens: 8000,
        cache_control: { type: "ephemeral" },
        output_config: { effort: "medium" },
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
      a.tokens.input += (res.usage.input_tokens || 0) + (res.usage.cache_read_input_tokens || 0) + (res.usage.cache_creation_input_tokens || 0);
      a.tokens.output += res.usage.output_tokens || 0;
      a.cost += costOf(config.model, res.usage);
      messages.push({ role: "assistant", content: res.content });

      if (res.stop_reason === "refusal") throw new Error("the model declined this goal");
      const calls = res.content.filter((b) => b.type === "tool_use");
      if (!calls.length) {
        if (nudged) break;
        nudged = true;
        messages.push({ role: "user", content: "Use your tools. Call done when you have reached the goal or cannot." });
        continue;
      }

      const results = [];
      let finished = null;
      for (const call of calls) {
        if (finished) { results.push({ type: "tool_result", tool_use_id: call.id, content: "Ignored: the attempt is finished." }); continue; }
        if (call.name === "done") {
          finished = call.input;
          results.push({ type: "tool_result", tool_use_id: call.id, content: "Recorded." });
          continue;
        }
        actions++;
        const cmd = `${call.name} ${JSON.stringify(call.input)}`;
        let out, ok = "ok";
        try { out = await act(call.name, call.input); }
        catch (err) { ok = "fail"; out = `Error: ${String(err.message).split("\n")[0]}\n${await view()}`; }
        a.trace.push({ at: new Date().toISOString(), name: call.name, cmd, out: out.slice(0, 600), ok });
        a.steps = a.trail.length;
        save();
        results.push({ type: "tool_result", tool_use_id: call.id, content: out, ...(ok === "fail" ? { is_error: true } : {}) });
      }
      if (finished) {
        Object.assign(a, { outcome: finished.outcome, summary: finished.summary });
        break;
      }
      if (actions >= config.maxActions && !nudged) {
        nudged = true;
        results.push({ type: "text", text: "You are out of actions. Call done now with your best outcome." });
      }
      messages.push({ role: "user", content: results });
    }
    if (!a.outcome) a.outcome = "gave_up";
  } catch (err) {
    Object.assign(a, { outcome: "error", error: String(err.message).split("\n")[0] });
  } finally {
    delete a.lastElements;
    a.steps = a.trail.length;
    a.status = a.outcome === "error" ? "error" : "done";
    a.cost = Math.round(a.cost * 10000) / 10000;
    save();
    await context.close().catch(() => {});
  }
}
