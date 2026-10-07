// Corgi Brain content script.
//
// Enumerates interactive elements, renders the spotlight overlay,
// handles cached-trail replay, and monitors DOM stability.

const MAX_ELEMENTS = 80;
const VIEWPORT_PAD = 200; // px of slack above/below the viewport
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=tab]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Map<number, Element> — index returned to SW resolves back to a live node here. */
let elementRegistry = new Map();

/** Map<string, Element> — fingerprint returned to SW resolves back to a live node. */
let fingerprintRegistry = new Map();

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (parseFloat(style.opacity || "1") < 0.1) return false;
  return true;
}

function isInExtendedViewport(el) {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  return (
    rect.bottom > -VIEWPORT_PAD &&
    rect.top < vh + VIEWPORT_PAD &&
    rect.right > 0 &&
    rect.left < vw
  );
}

function textOf(el) {
  // Visible text (no markup), trimmed and capped.
  const raw =
    el.getAttribute("aria-label") ||
    el.innerText ||
    el.value ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 80);
}

function describe(el, idx) {
  const rect = el.getBoundingClientRect();
  return {
    idx,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || undefined,
    text: textOf(el),
    aria: el.getAttribute("aria-label") || undefined,
    testid: el.getAttribute("data-testid") || undefined,
    fid: elementFingerprint(el) || undefined,
    bbox: [
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
    ],
  };
}

function buildElementList() {
  const all = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const visible = all.filter((el) => isVisible(el) && isInExtendedViewport(el));

  // Stable order: by document position (querySelectorAll order is doc order).
  const picked = visible.slice(0, MAX_ELEMENTS);

  elementRegistry = new Map();
  fingerprintRegistry = new Map();
  const out = picked.map((el, i) => {
    elementRegistry.set(i, el);
    const fid = elementFingerprint(el);
    if (fid) fingerprintRegistry.set(fid, el);
    return describe(el, i);
  });

  return out;
}

function resolveIndex(idx) {
  const el = elementRegistry.get(idx);
  if (!el || !el.isConnected) return null;
  return el;
}

// ─── element fingerprinting ──────────────────────────────────────────────────

/** Auto-generated IDs that shift across navigations — skip these for fingerprints. */
const UNSTABLE_ID_PATTERN = /^(:r[a-z0-9]+:|_r_[a-z0-9]+_|react-|turbo-|__next|radix-)|[0-9a-f]{8}-[0-9a-f]{4}-|\d{4,}|[0-9a-f]{12,}/i;

function elementFingerprint(el) {
  // Priority: data-testid → stable id → aria-label+tag → text+tag+role
  const testid = el.getAttribute("data-testid");
  if (testid) return `tid:${testid}`;

  const id = el.id;
  if (id && !UNSTABLE_ID_PATTERN.test(id)) return `id:${id}`;

  const tag = el.tagName.toLowerCase();
  const aria = (el.getAttribute("aria-label") || "").trim();
  if (aria) return `fp:${tag}:${aria}`;

  const text = textOf(el).slice(0, 40);
  const role = el.getAttribute("role") || "";
  if (text) return `fp:${tag}:${role}:${text}`;

  return null;
}

function resolveFingerprint(fid) {
  if (!fid) return null;
  const el = fingerprintRegistry.get(fid);
  if (el && el.isConnected) return el;
  return null;
}

function elementSignature(el) {
  // Stable-ish descriptor used to re-find an element during cached-trail replay.
  return {
    tag: el.tagName.toLowerCase(),
    text: textOf(el).toLowerCase(),
    aria: (el.getAttribute("aria-label") || "").toLowerCase() || undefined,
    testid: el.getAttribute("data-testid") || undefined,
    role: el.getAttribute("role") || undefined,
  };
}

// ─── overlay ──────────────────────────────────────────────────────────────────

const OVERLAY_IDS = [
  "__evernav_backdrop__",
  "__evernav_clone__",
  "__evernav_halo__",
  "__evernav_tooltip__",
  "__evernav_user_message__",
];

let overlayState = null; // { target, onResize, onClick, instruction }

function clearOverlay() {
  for (const id of OVERLAY_IDS) {
    document.getElementById(id)?.remove();
  }
  if (overlayState) {
    window.removeEventListener("scroll", overlayState.onResize, true);
    window.removeEventListener("resize", overlayState.onResize);
    if (overlayState.target && overlayState.onClick) {
      overlayState.target.removeEventListener("click", overlayState.onClick, true);
    }
    if (overlayState.target && overlayState.onChange) {
      overlayState.target.removeEventListener("change", overlayState.onChange, true);
    }
    overlayState = null;
  }
}

function positionElements(target) {
  const rect = target.getBoundingClientRect();
  const HALO_PAD = 12;   // room for the glow + ring stack
  const CLONE_PAD = 3;   // a touch larger than the element so blur edges never seep through
  const halo = document.getElementById("__evernav_halo__");
  const clone = document.getElementById("__evernav_clone__");
  const tip = document.getElementById("__evernav_tooltip__");

  if (halo) {
    halo.style.top = `${rect.top - HALO_PAD}px`;
    halo.style.left = `${rect.left - HALO_PAD}px`;
    halo.style.width = `${rect.width + HALO_PAD * 2}px`;
    halo.style.height = `${rect.height + HALO_PAD * 2}px`;
  }

  if (clone) {
    clone.style.top = `${rect.top - CLONE_PAD}px`;
    clone.style.left = `${rect.left - CLONE_PAD}px`;
    clone.style.width = `${rect.width + CLONE_PAD * 2}px`;
    clone.style.height = `${rect.height + CLONE_PAD * 2}px`;
    clone.style.padding = `${CLONE_PAD}px`;
  }

  if (tip) {
    const tipRect = tip.getBoundingClientRect();
    const below = rect.bottom + 12;
    const above = rect.top - tipRect.height - 12;
    const top = below + tipRect.height < window.innerHeight ? below : Math.max(8, above);
    const leftRaw = rect.left + rect.width / 2 - tipRect.width / 2;
    const left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, leftRaw));
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }
}

function renderOverlay(target, instruction, opts = {}) {
  clearOverlay();
  if (!target) return false;

  target.scrollIntoView({ block: "center", behavior: "instant" });

  // Form-field steps skip the blur + clone so the person sees what they type.
  const typingStep = opts.advanceOn === "fill" || opts.advanceOn === "select";

  // Backdrop (blur layer)
  const backdrop = document.createElement("div");
  backdrop.id = "__evernav_backdrop__";
  if (!typingStep) document.documentElement.appendChild(backdrop);

  // Clone of target so it appears sharp above the blurred backdrop.
  // Using a literal innerHTML clone preserves rendered look without hooking
  // up React/Turbo internals.
  //
  // The clone wrapper inherits the page's body bg + text color so the
  // cloned element keeps the same readability it had in context. (Without
  // this, dark-mode GitHub's white text rendered on the previous cream
  // background was invisible — see screenshot bug.)
  const clone = document.createElement("div");
  clone.id = "__evernav_clone__";
  const bodyStyle = getComputedStyle(document.body);
  const pageBg = bodyStyle.backgroundColor;
  const pageColor = bodyStyle.color;
  // If body bg is transparent (rare), fall back to the html element's bg.
  const effectiveBg =
    pageBg && pageBg !== "rgba(0, 0, 0, 0)" && pageBg !== "transparent"
      ? pageBg
      : getComputedStyle(document.documentElement).backgroundColor || "#F8F8F7";
  clone.style.background = effectiveBg;
  clone.style.color = pageColor || "inherit";
  clone.innerHTML = target.outerHTML;
  // Strip ids from cloned subtree to avoid duplicate-id pollution.
  clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  if (!typingStep) document.documentElement.appendChild(clone);

  // Halo
  const halo = document.createElement("div");
  halo.id = "__evernav_halo__";
  document.documentElement.appendChild(halo);

  // Tooltip
  if (instruction) {
    const tip = document.createElement("div");
    tip.id = "__evernav_tooltip__";
    tip.innerHTML = `<span class="__evernav_kicker__">Next step</span>${escapeHtml(instruction)}`;
    document.documentElement.appendChild(tip);
  }

  positionElements(target);

  // Reposition on scroll/resize. capture:true on scroll catches nested scrolls.
  const onResize = () => positionElements(target);
  window.addEventListener("scroll", onResize, true);
  window.addEventListener("resize", onResize);

  // Advance when the user does the step: click by default, or finishing a
  // form field (change) for fill/select steps. Field values are never read,
  // only whether the field is empty.
  let done = false;
  const onClick = () => {
    if (done) return;
    done = true;
    const sig = isFormField(target) ? safeSignature(target) : elementSignature(target);
    chrome.runtime.sendMessage({
      type: "STEP_COMPLETED",
      stepIndex: opts.stepIndex ?? null,
      target: sig,
    });
    clearOverlay();
    if (typeof opts.onCompleted === "function") {
      // Defer so the page's own click handler runs first.
      setTimeout(opts.onCompleted, 0);
    }
  };
  let onChange = null;
  if (opts.advanceOn === "fill" || opts.advanceOn === "select") {
    onChange = () => {
      if (opts.advanceOn === "fill" && target.value === "") return;
      target.removeEventListener("change", onChange, true);
      onClick();
    };
    target.addEventListener("change", onChange, true);
    target.focus?.();
  } else {
    target.addEventListener("click", onClick, { once: true, capture: true });
  }

  overlayState = { target, onResize, onClick, onChange, instruction };
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ─── "agent thinking" indicator (shown while waiting for Claude) ─────────────

let thinkingEl = null;
let thinkingDim = null;

function showThinking(label) {
  hideThinking();

  thinkingDim = document.createElement("div");
  thinkingDim.id = "__evernav_thinking_dim__";
  document.documentElement.appendChild(thinkingDim);

  thinkingEl = document.createElement("div");
  thinkingEl.id = "__evernav_thinking__";
  thinkingEl.innerHTML = `
    <span class="__evernav_orb__"></span>
    <span class="__evernav_label__">${escapeHtml(label || "Corgi Brain is thinking")}</span>
    <span class="__evernav_dots__"><span></span><span></span><span></span></span>
  `;
  document.documentElement.appendChild(thinkingEl);
}

function hideThinking() {
  thinkingEl?.remove();
  thinkingEl = null;
  thinkingDim?.remove();
  thinkingDim = null;
}

// ─── persistent control bar (Stop button while guidance is active) ──────────

let controlEl = null;

function showControl(task) {
  hideControl();
  controlEl = document.createElement("div");
  controlEl.id = "__evernav_control__";
  controlEl.innerHTML = `
    <span class="__evernav_control_dot__"></span>
    <span class="__evernav_control_label__">Guiding</span>
    <span class="__evernav_control_task__">${escapeHtml(task || "")}</span>
    <button class="__evernav_stop__" type="button">Stop</button>
  `;
  document.documentElement.appendChild(controlEl);
  controlEl.querySelector(".__evernav_stop__").addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "STOP_GUIDANCE_FROM_PAGE" });
  });
}

function hideControl() {
  controlEl?.remove();
  controlEl = null;
}

// ─── user message toast (error/warning feedback) ─────────────────────────────

let userMessageEl = null;
let userMessageTimer = null;

function showUserMessage(message, level = "error") {
  hideUserMessage();
  userMessageEl = document.createElement("div");
  userMessageEl.id = "__evernav_user_message__";
  const levelClass = `__evernav_level_${level}__`;
  userMessageEl.className = levelClass;
  userMessageEl.textContent = message;
  document.documentElement.appendChild(userMessageEl);
  // Auto-dismiss after 8 seconds
  userMessageTimer = setTimeout(() => hideUserMessage(), 8000);
}

function hideUserMessage() {
  clearTimeout(userMessageTimer);
  userMessageTimer = null;
  userMessageEl?.remove();
  userMessageEl = null;
}

// ─── signature-based element re-finding (for cached trail replay) ─────────────

function scoreMatch(candSig, want) {
  if (!candSig.tag || candSig.tag !== want.tag) return 0;
  let score = 10; // base tag match

  // data-testid exact match is authoritative
  if (want.testid && candSig.testid === want.testid) return 200;

  // Exact text match
  if (want.text && candSig.text && candSig.text === want.text) score += 50;
  // Partial text match (weaker)
  else if (want.text && candSig.text && candSig.text.includes(want.text)) score += 15;
  else if (want.text && candSig.text && want.text.includes(candSig.text)) score += 20;

  // Exact aria match
  if (want.aria && candSig.aria && candSig.aria === want.aria) score += 30;
  // Partial aria match
  else if (want.aria && candSig.aria && candSig.aria.includes(want.aria)) score += 15;

  // Role match
  if (want.role && candSig.role === want.role) score += 10;

  return score;
}

function findElementBySignature(want) {
  const all = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  let best = null;
  let bestScore = 0;
  for (const el of all) {
    if (!isVisible(el)) continue;
    const sig = elementSignature(el);
    const s = scoreMatch(sig, want);
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }
  // Require at least a tag match + one strong attribute.
  return bestScore >= 40 ? best : null;
}

function findElementByFingerprint(fid) {
  if (!fid) return null;
  // First check registry from last buildElementList
  const cached = fingerprintRegistry.get(fid);
  if (cached && cached.isConnected && isVisible(cached)) return cached;
  // Scan the DOM for a fresh match
  const all = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  for (const el of all) {
    if (!isVisible(el)) continue;
    if (elementFingerprint(el) === fid) return el;
  }
  return null;
}

// ─── cached-trail replay ──────────────────────────────────────────────────────

let activeReplay = null;

function navTarget(step) {
  if (step.href) return step.href;
  if (!step.url) return null;
  try { return new URL(step.url, location.origin).href; } catch { return null; }
}
function samePage(href) {
  try { const u = new URL(href); return u.origin === location.origin && u.pathname.replace(/\/$/, "") === location.pathname.replace(/\/$/, ""); }
  catch { return false; }
}

function startReplay(trail, startIndex = 0) {
  activeReplay = { trail, step: startIndex, token: Math.random() };
  advanceReplay();
}

const FIELD_SELECTOR = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select";

// Find the element for a recorded step: fingerprint, then signature, then
// (for form fields) the field's visible label.
function findStepTarget(step) {
  let el = step.fid ? findElementByFingerprint(step.fid) : null;
  if (!el && step.target) el = findElementBySignature(step.target);
  if (!el && (step.field || step.label)) {
    const want = String(step.field || step.label).toLowerCase();
    const pool = step.kind === "click"
      ? Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR + ",label,summary"))
      : Array.from(document.querySelectorAll(FIELD_SELECTOR));
    el = pool.find((c) => isVisible(c) && labelOf(c).toLowerCase() === want) ||
         pool.find((c) => isVisible(c) && labelOf(c).toLowerCase().includes(want)) || null;
  }
  return el;
}

// Poll for a target for up to ~2.5s: SPA pages render late.
async function waitForStepTarget(step) {
  for (let i = 0; i < 6; i++) {
    const el = findStepTarget(step);
    if (el) return el;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function advanceReplay() {
  if (!activeReplay) return;
  const { trail, step, token } = activeReplay;
  if (step >= trail.length) {
    activeReplay = null;
    chrome.runtime.sendMessage({ type: "TRAIL_COMPLETE" });
    return;
  }
  const cur = trail[step];
  chrome.runtime.sendMessage({ type: "REPLAY_PROGRESS", index: step });
  const next = () => {
    if (!activeReplay || activeReplay.token !== token) return;
    activeReplay.step += 1;
    advanceReplay();
  };

  // Let the DOM settle after the previous action before re-searching.
  setTimeout(async () => {
    if (!activeReplay || activeReplay.token !== token) return; // cancelled or restarted

    if (cur.kind === "verify") {
      await verifyStep(cur);
      return next();
    }

    // Navigation steps (explorers record these when they jump straight to a URL).
    // Already there: move on. Otherwise open the page; replay resumes on load at this
    // same step, which then matches and advances.
    if (cur.kind === "nav") {
      const target = navTarget(cur);
      if (!target || samePage(target)) return next();
      showUserMessage(`Opening ${target}`, "info");
      setTimeout(() => location.assign(target), 250);
      return;
    }

    const target = await waitForStepTarget(cur);
    if (!activeReplay || activeReplay.token !== token) return;
    if (!target) {
      chrome.runtime.sendMessage({
        type: "STEP_FAILED",
        stepIndex: step,
        reason: "signature_not_found",
        want: cur.target || { field: cur.field },
      });
      activeReplay = null;
      return;
    }
    const advanceOn = cur.kind === "fill" ? "fill" : cur.kind === "select" ? "select" : "click";
    renderOverlay(target, cur.instruction || "Click to continue", {
      stepIndex: step,
      advanceOn,
      onCompleted: next,
    });
  }, 300);
}

// The last step: wait briefly for the success text, then report done either way.
async function verifyStep(step) {
  const want = String(step.textIncludes || "").trim().toLowerCase();
  for (let i = 0; i < 10 && want; i++) {
    if (document.body.innerText.toLowerCase().includes(want)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  showUserMessage(`✓ ${step.instruction || "Done."}`, "info");
}

// ─── team workflows: record mode ──────────────────────────────────────────────
//
// Captures what a person clicks and which fields they fill, as labels and
// fingerprints only. Typed text is never read or sent; for fields we only
// check whether the value is empty.

const SECRET_RE = /pass|pwd|token|secret|otp|2fa|mfa|cvv|cvc|card|ssn|\bpin\b|api[-_ ]?key|auth/i;
const TYPING_TYPES = /^(text|email|password|search|tel|url|number|date|datetime-local|month|week|time)?$/i;

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function isFormField(el) {
  if (!el?.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  return tag === "input" && TYPING_TYPES.test(el.type || "");
}

// The human label of an element, without ever touching el.value.
function labelOf(el) {
  if (!el?.getAttribute) return "";
  const byIds = el.getAttribute("aria-labelledby");
  if (byIds) {
    const s = cleanText(byIds.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
    if (s) return s;
  }
  const aria = cleanText(el.getAttribute("aria-label"));
  if (aria) return aria;
  if (el.labels && el.labels.length) {
    const s = cleanText(el.labels[0].innerText);
    if (s) return s;
  }
  const wrap = el.closest?.("label");
  if (wrap && wrap !== el) {
    const s = cleanText(wrap.innerText);
    if (s) return s;
  }
  if (isFormField(el)) return cleanText(el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title"));
  return cleanText(el.innerText || el.getAttribute("title") || el.getAttribute("alt") || el.querySelector?.("img[alt]")?.alt);
}

const PLAIN_LABEL_RE = /^(name|title|description|note|notes|label|username|email|search|url)\b/i;

function isSecret(el) {
  if (!el?.getAttribute) return false;
  if ((el.type || "").toLowerCase() === "password") return true;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac.includes("password") || ac.startsWith("cc-") || ac === "one-time-code") return true;
  // A plainly labeled field ("Name", "Title") is not secret even if its id
  // mentions one (GitHub's secret-name field is id="secret_name").
  const label = labelOf(el);
  if (PLAIN_LABEL_RE.test(label)) return false;
  return SECRET_RE.test([el.name, el.id, el.getAttribute("aria-label"), label, el.getAttribute("placeholder")].join(" "));
}

// Signature/fingerprint for form fields built from the label, never the value.
function safeSignature(el) {
  return {
    tag: el.tagName.toLowerCase(),
    text: labelOf(el).toLowerCase(),
    aria: (el.getAttribute("aria-label") || "").toLowerCase() || undefined,
    testid: el.getAttribute("data-testid") || undefined,
    role: el.getAttribute("role") || undefined,
  };
}
function safeFingerprint(el) {
  const testid = el.getAttribute("data-testid");
  if (testid) return `tid:${testid}`;
  if (el.id && !UNSTABLE_ID_PATTERN.test(el.id)) return `id:${el.id}`;
  const label = labelOf(el);
  return label ? `fp:${el.tagName.toLowerCase()}::${label.slice(0, 40)}` : null;
}

const RECORD_CLICK_SELECTOR = INTERACTIVE_SELECTOR + ",label,summary,[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=switch]";
let recording = null; // { task, count }
let recordBarEl = null;
let recordObserver = null;

function isOwnUi(el) {
  return !!el?.closest?.('[id^="__evernav"]');
}

function sendRecordEvent(event) {
  if (!recording) return;
  try {
    chrome.runtime.sendMessage({ type: "RECORD_EVENT", event: { ...event, t: Date.now(), url: location.pathname } });
    console.log("[browser-brain/record]", event.kind, event.label || event.field || event.sample || "");
    recording.count += 1;
    updateRecordBar();
  } catch { /* extension reloaded */ }
}

function onRecordPointer(e) {
  if (!recording) return;
  const el = e.target?.closest?.(RECORD_CLICK_SELECTOR);
  if (!el || isOwnUi(el)) return;
  // Clicking into a text field is noise; the fill is captured on change.
  if (isFormField(el) && el.tagName.toLowerCase() !== "select") return;
  sendRecordEvent({
    kind: "click",
    target: elementSignature(el),
    fid: elementFingerprint(el),
    label: labelOf(el),
  });
}

function onRecordChange(e) {
  if (!recording) return;
  const el = e.target;
  if (!el || isOwnUi(el)) return;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "select") {
    const secret = isSecret(el);
    sendRecordEvent({
      kind: "select",
      field: labelOf(el),
      fid: safeFingerprint(el),
      target: safeSignature(el),
      option: secret ? undefined : cleanText(el.selectedOptions?.[0]?.text),
      secret,
    });
  } else if (isFormField(el)) {
    sendRecordEvent({
      kind: "fill",
      field: labelOf(el),
      fid: safeFingerprint(el),
      target: safeSignature(el),
      hasValue: el.value !== "",
      secret: isSecret(el),
    });
  }
}

function watchFlashMessages() {
  recordObserver?.disconnect();
  recordObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof Element) || isOwnUi(n)) continue;
        const flash = n.matches?.('.flash, [role=alert], .Toast, [data-flash]') ? n : n.querySelector?.('.flash, [role=alert], .Toast, [data-flash]');
        if (!flash || !isVisible(flash) || /another tab or window/i.test(flash.innerText)) continue;
        const text = cleanText(flash.innerText).slice(0, 120);
        if (text) sendRecordEvent({ kind: "pageText", sample: text });
      }
    }
  });
  recordObserver.observe(document.body, { childList: true, subtree: true });
  // A flash already on the page right after a navigation (e.g. "Secret added").
  const shown = Array.from(document.querySelectorAll(".flash, [role=alert], .Toast"))
    .find((f) => isVisible(f) && !/another tab or window/i.test(f.innerText));
  const existing = cleanText(shown?.innerText).slice(0, 120);
  if (existing) sendRecordEvent({ kind: "pageText", sample: existing });
}

function showRecordBar() {
  recordBarEl?.remove();
  recordBarEl = document.createElement("div");
  recordBarEl.id = "__evernav_control__";
  recordBarEl.innerHTML = `
    <span class="__evernav_control_dot__"></span>
    <span class="__evernav_control_label__">Recording</span>
    <span class="__evernav_control_task__"></span>
    <button class="__evernav_stop__" type="button">Stop &amp; save</button>
  `;
  document.documentElement.appendChild(recordBarEl);
  recordBarEl.querySelector(".__evernav_stop__").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "RECORD_STOP" });
  });
  updateRecordBar();
}

function updateRecordBar() {
  const t = recordBarEl?.querySelector(".__evernav_control_task__");
  if (t && recording) t.textContent = `${recording.task || "Recording"} · ${recording.count} steps · values never recorded`;
}

function armRecording(task, count = 0) {
  if (recording) return;
  console.log("[browser-brain/record] armed on", location.pathname);
  recording = { task, count };
  window.addEventListener("pointerdown", onRecordPointer, true);
  window.addEventListener("change", onRecordChange, true);
  watchFlashMessages();
  showRecordBar();
}

function disarmRecording() {
  recording = null;
  window.removeEventListener("pointerdown", onRecordPointer, true);
  window.removeEventListener("change", onRecordChange, true);
  recordObserver?.disconnect();
  recordObserver = null;
  recordBarEl?.remove();
  recordBarEl = null;
}

// On every page load, ask whether this tab is being recorded.
try {
  chrome.runtime.sendMessage({ type: "RECORD_STATUS" }).then((r) => {
    if (r?.recording) armRecording(r.task, r.count);
  }).catch(() => {});
} catch { /* ignore */ }

// ─── team workflows: guide page handoff (bridge /guide/:id) ──────────────────

// Guide pages live at /guide/<id> on the bridge, or under a prefix such as
// /compute/v1/bridge/guide/<id> on the hosted deployment. The bridge is whatever served this page.
if (/\/guide\/[^/]+\/?$/.test(location.pathname) && document.body?.dataset?.workflowId) {
  const bridge = location.origin + location.pathname.replace(/\/guide\/[^/]+\/?$/, "");
  const btn = document.getElementById("browser-brain-start");
  btn?.addEventListener("click", async () => {
    const status = document.getElementById("status");
    if (status) status.textContent = "Opening the site and starting the guide…";
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: "GUIDE_ME", id: document.body.dataset.workflowId, bridge }); } catch (err) { r = { ok: false, error: err.message }; }
    if (r && r.ok === false && status) status.textContent = r.error || "Couldn't start the guide.";
  });
}

// ─── DOM stability detection ──────────────────────────────────────────────────
//
// Replaces a hardcoded 1500ms wait with a signal-based mechanism.
// The background script sends WAIT_FOR_SETTLED and gets a promise that
// resolves when the DOM has been quiet for SETTLE_DEBOUNCE ms.

const DomStabilityMonitor = {
  SETTLE_DEBOUNCE: 400,   // ms of DOM quiet before "settled"
  HARD_TIMEOUT: 5000,     // ms max wait regardless of mutations
  _settled: true,
  _timer: null,
  _hardTimer: null,
  _pendingResolves: [],
  _bodyChildCount: 0,

  onMutation() {
    this._settled = false;

    // Detect full-page swap: if >50% of body children were removed,
    // use a longer debounce for the content to stabilize.
    const currentCount = document.body ? document.body.children.length : 0;
    const lostMajority = this._bodyChildCount > 0 && currentCount < this._bodyChildCount * 0.5;
    this._bodyChildCount = currentCount;
    const debounce = lostMajority ? 800 : this.SETTLE_DEBOUNCE;

    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._onSettle(), debounce);
  },

  _timedOut: false,

  _onSettle() {
    this._settled = true;
    clearTimeout(this._hardTimer);
    this._hardTimer = null;
    const didTimeout = this._timedOut;
    this._timedOut = false;
    const resolves = this._pendingResolves.splice(0);
    for (const r of resolves) r({ timedOut: didTimeout });
  },

  waitForSettled() {
    if (this._settled) return Promise.resolve({ timedOut: false });
    return new Promise((resolve) => {
      this._pendingResolves.push(resolve);
      // Hard timeout: don't wait forever.
      if (!this._hardTimer) {
        this._hardTimer = setTimeout(() => {
          this._timedOut = true;
          this._onSettle();
        }, this.HARD_TIMEOUT);
      }
    });
  },
};

// Initialize body child count.
DomStabilityMonitor._bodyChildCount = document.body ? document.body.children.length : 0;

// ─── turbo + mutation handling ────────────────────────────────────────────────
//
// GitHub uses Turbo (turbo:load, turbo:render, turbo:frame-load) to swap DOM
// without a full page navigation. Any active overlay must be torn down or it
// will point at a detached node.

function onPageReshape() {
  if (overlayState && (!overlayState.target.isConnected || !document.documentElement.contains(overlayState.target))) {
    clearOverlay();
    // If we're mid-replay, advanceReplay will re-search on the next tick.
    if (activeReplay) advanceReplay();
  }
}

["turbo:load", "turbo:render", "turbo:frame-load", "turbo:visit"].forEach((evt) => {
  document.addEventListener(evt, () => {
    DomStabilityMonitor.onMutation();
    // Wait a beat for the new DOM to actually be present.
    setTimeout(onPageReshape, 100);
  });
});

const mo = new MutationObserver(() => {
  DomStabilityMonitor.onMutation();
  if (overlayState) onPageReshape();
});
mo.observe(document.documentElement, { childList: true, subtree: true });

// ─── hard navigation detection ────────────────────────────────────────────────

window.addEventListener("beforeunload", () => {
  // Best-effort signal: content script is about to die.
  try {
    chrome.runtime.sendMessage({ type: "PAGE_NAVIGATING" });
  } catch {
    // Extension context may already be invalidated — swallow.
  }
});

// ─── messaging ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "ENUMERATE_ELEMENTS": {
          const elements = buildElementList();
          sendResponse({ ok: true, elements, url: location.href });
          break;
        }
        case "REPLAY_TRAIL": {
          startReplay(msg.trail || [], msg.startIndex || 0);
          sendResponse({ ok: true, queued: msg.trail?.length || 0 });
          break;
        }
        case "CANCEL_REPLAY": {
          activeReplay = null;
          clearOverlay();
          sendResponse({ ok: true });
          break;
        }
        case "RECORD_ARM": {
          armRecording(msg.task);
          sendResponse({ ok: true });
          break;
        }
        case "RECORD_DISARM": {
          disarmRecording();
          sendResponse({ ok: true });
          break;
        }
        case "HIGHLIGHT_INDEX": {
          hideThinking();
          // Prefer fingerprint resolution, fall back to positional index.
          let el = null;
          let resolvedBy = "none";
          if (msg.fid) {
            el = resolveFingerprint(msg.fid);
            if (el) resolvedBy = "fingerprint";
          }
          if (!el && msg.idx != null) {
            el = resolveIndex(msg.idx);
            if (el) resolvedBy = "index";
          }
          const drawn = renderOverlay(el, msg.instruction, { stepIndex: msg.stepIndex });
          sendResponse({ ok: drawn, found: !!el, resolvedBy });
          break;
        }
        case "WAIT_FOR_SETTLED": {
          const settleResult = await DomStabilityMonitor.waitForSettled();
          sendResponse({ ok: true, settled: true, timedOut: settleResult?.timedOut ?? false });
          break;
        }
        case "CLEAR_OVERLAY": {
          hideThinking();
          clearOverlay();
          sendResponse({ ok: true });
          break;
        }
        case "SHOW_THINKING": {
          showThinking(msg.label);
          sendResponse({ ok: true });
          break;
        }
        case "HIDE_THINKING": {
          hideThinking();
          sendResponse({ ok: true });
          break;
        }
        case "SHOW_CONTROL": {
          showControl(msg.task);
          sendResponse({ ok: true });
          break;
        }
        case "HIDE_CONTROL": {
          hideControl();
          sendResponse({ ok: true });
          break;
        }
        case "SHOW_USER_MESSAGE": {
          showUserMessage(msg.message, msg.level || "error");
          sendResponse({ ok: true });
          break;
        }
        case "HIDE_USER_MESSAGE": {
          hideUserMessage();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown type: ${msg.type}` });
      }
    } catch (e) {
      console.error("[evernav/content]", e);
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

// ─── demo-day hot-key safety net ──────────────────────────────────────────────
//
// Esoteric combinations to avoid clashes with github.com's own keybindings.
// Triggered off-screen by a co-driver when a demo beat fails.

const HOTKEYS = {
  Digit1: { type: "DEMO_FORCE_BEAT_1" },
  Digit2: { type: "DEMO_FORCE_BEAT_2" },
  KeyD:   { type: "DEMO_OPEN_DASHBOARD" },
  KeyL:   { type: "DEMO_TOGGLE_BIG_BADGE" },
};

window.addEventListener(
  "keydown",
  (e) => {
    if (!e.shiftKey || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    const action = HOTKEYS[e.code];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action.type === "DEMO_TOGGLE_BIG_BADGE") {
      toggleBigBadge();
    } else {
      chrome.runtime.sendMessage(action);
    }
  },
  true
);

// Big user-id badge: makes the user-switch unmistakable on the projected screen.
let bigBadgeEl = null;
function toggleBigBadge() {
  if (bigBadgeEl) {
    bigBadgeEl.remove();
    bigBadgeEl = null;
    return;
  }
  chrome.storage.session.get("activeUser").then(({ activeUser }) => {
    bigBadgeEl = document.createElement("div");
    bigBadgeEl.id = "__evernav_big_badge__";
    Object.assign(bigBadgeEl.style, {
      position: "fixed",
      top: "24px",
      right: "24px",
      zIndex: "2147483647",
      padding: "14px 24px",
      background: "#3ECF8E",
      color: "#FFFFFF",
      font: "800 28px/1 'Archivo', 'Helvetica Neue', Arial, sans-serif",
      letterSpacing: "0.5px",
      textTransform: "uppercase",
      border: "1px solid #FFFFFF",
      borderRadius: "4px",
      boxShadow: "0 20px 60px rgba(0, 0, 0, 0.35), 0 0 32px rgba(62, 207, 142, 0.35)",
      pointerEvents: "none",
    });
    bigBadgeEl.textContent = activeUser || "you";
    document.documentElement.appendChild(bigBadgeEl);
  });
}

console.log("[evernav/content] loaded on", location.href);
