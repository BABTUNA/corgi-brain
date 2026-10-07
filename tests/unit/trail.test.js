import { describe, it, expect } from "vitest";
import { parseTrail, rankTrails } from "../../bridge/lib/trail.js";

const done = { outcome: "reached", trail: [{ kind: "click", instruction: "Click Domain Names", target: { tag: "A", text: "Domain Names" }, fid: "fp:a::Domain Names", url: "/domains" }], deadEnds: 0 };

describe("parseTrail", () => {
  it("reads the JSON the done command prints", () => {
    const p = parseTrail(JSON.stringify(done));
    expect(p.outcome).toBe("reached");
    expect(p.trail).toHaveLength(1);
    expect(p.trail[0].target).toEqual({ tag: "a", text: "domain names" });
    expect(p.trail[0].fid).toBe("fp:a::Domain Names");
  });
  it("tolerates a code fence and prose around the JSON", () => {
    const p = parseTrail("Here you go:\n```json\n" + JSON.stringify(done) + "\n```\nDone.");
    expect(p.outcome).toBe("reached");
    expect(p.trail).toHaveLength(1);
  });
  it("keeps absolute hrefs on nav steps and drops relative ones", () => {
    const p = parseTrail(JSON.stringify({ outcome: "reached", trail: [
      { kind: "nav", instruction: "Go to https://www.iana.org/help", href: "https://www.iana.org/help", url: "/help" },
      { kind: "nav", instruction: "Go somewhere", href: "/relative", url: "/relative" },
    ] }));
    expect(p.trail[0].href).toBe("https://www.iana.org/help");
    expect(p.trail[1].href).toBeUndefined();
  });
  it("gives up when there is no JSON", () => {
    expect(parseTrail("I reached the goal by clicking around.")).toEqual({ outcome: "gave_up", trail: null, deadEnds: null });
  });
  it("normalises unknown kinds to click", () => {
    const p = parseTrail(JSON.stringify({ outcome: "reached", trail: [{ kind: "tap", instruction: "Tap it" }] }));
    expect(p.trail[0].kind).toBe("click");
  });
});

describe("rankTrails", () => {
  const agent = (i, steps, deadEnds = 0, fids = steps) => ({ i, trail: Array.from({ length: steps }, (_, n) => ({ instruction: `s${n}`, fid: n < fids ? `fp:${n}` : undefined })), deadEnds });
  it("prefers fewer steps", () => {
    expect(rankTrails([agent(0, 5), agent(1, 2), agent(2, 3)]).map((a) => a.i)).toEqual([1, 2, 0]);
  });
  it("breaks ties on dead ends", () => {
    expect(rankTrails([agent(0, 3, 2), agent(1, 3, 0)]).map((a) => a.i)).toEqual([1, 0]);
  });
  it("rewards fingerprints that replay without vision", () => {
    expect(rankTrails([agent(0, 3, 0, 0), agent(1, 3, 0, 3)]).map((a) => a.i)).toEqual([1, 0]);
  });
  it("drops agents without a trail", () => {
    expect(rankTrails([{ i: 0, trail: null }, agent(1, 1)]).map((a) => a.i)).toEqual([1]);
  });
});
