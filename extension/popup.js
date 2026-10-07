const $ = (id) => document.getElementById(id);
const DEFAULT_BRIDGE = "http://localhost:8787";

async function bridgeUrl() {
  const { bridgeUrl } = await chrome.storage.local.get("bridgeUrl");
  return (bridgeUrl || DEFAULT_BRIDGE).replace(/\/+$/, "");
}

// Who is recording or being guided. Two teammates for the demo; Switch cycles.
const USERS = ["maya", "ben"];

async function getActiveUser() {
  const { activeUser } = await chrome.storage.session.get("activeUser");
  return activeUser || USERS[0];
}

async function setActiveUser(u) {
  await chrome.storage.session.set({ activeUser: u });
  $("userBadge").textContent = u;
}

async function init() {
  const u = await getActiveUser();
  await chrome.storage.session.set({ activeUser: u }); // so the guide page knows who's replaying
  $("userBadge").textContent = u;

  $("switchUser").addEventListener("click", async () => {
    const cur = await getActiveUser();
    const next = USERS[(USERS.indexOf(cur) + 1) % USERS.length];
    await setActiveUser(next);
    setStatus(`Switched to ${next}.`);
  });

  $("go").addEventListener("click", startGuidance);
  $("task").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startGuidance();
  });
  $("stop").addEventListener("click", stopGuidance);
  $("record").addEventListener("click", startRecording);
  $("discover").addEventListener("click", startDiscover);
  $("seeAll").addEventListener("click", async (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: `${await bridgeUrl()}/library` });
  });
  loadWorkflows();
  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function setStatus(msg, cls = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + cls;
}

async function startGuidance() {
  if ($("go").disabled) return;
  $("go").disabled = true;
  try { await startGuidanceInner(); } finally { $("go").disabled = false; }
}

async function startGuidanceInner() {
  const task = $("task").value.trim();
  if (!task) {
    setStatus("Type what you want to do first.", "err");
    return;
  }
  const user = await getActiveUser();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    setStatus("Open an https:// page first (chrome:// and similar can't be guided).", "err");
    return;
  }

  $("go").disabled = true;
  setStatus("Asking the agent…");

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "START_GUIDANCE",
      task,
      user,
      tabId: tab.id,
      url: tab.url,
    });
    if (resp?.ok) {
      setStatus("Agent is reading the page — follow the green glow.", "hit");
    } else {
      setStatus(resp?.error || "Failed to start.", "err");
    }
  } catch (e) {
    setStatus(String(e.message || e), "err");
  } finally {
    $("go").disabled = false;
  }
}

async function stopGuidance() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: "STOP_GUIDANCE", tabId: tab.id });
  setStatus("Stopped.");
}

async function startRecording() {
  if ($("record").disabled) return;
  $("record").disabled = true;
  try { await startRecordingInner(); } finally { $("record").disabled = false; }
}

async function startRecordingInner() {
  const task = $("task").value.trim();
  if (!task) {
    setStatus("Type what you're about to do, then press Record.", "err");
    return;
  }
  const user = await getActiveUser();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    setStatus("Open the website you want to record first.", "err");
    return;
  }
  const resp = await chrome.runtime.sendMessage({ type: "RECORD_START", task, user, tabId: tab.id, url: tab.url });
  if (resp?.ok) {
    setStatus("Recording. Do the task normally, then press Stop & save on the page.", "hit");
    setTimeout(() => window.close(), 900);
  } else {
    setStatus(resp?.error || "Couldn't start recording.", "err");
  }
}

// Explore mode: agents discover the path on a public site, then the exploration page opens.
async function startDiscover() {
  const goal = $("task").value.trim();
  if (!goal) {
    setStatus("Type what you want agents to figure out, then press Discover.", "err");
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    setStatus("Open the public website to explore first.", "err");
    return;
  }
  $("discover").disabled = true;
  setStatus("Sending agents…");
  try {
    const base = await bridgeUrl();
    if (tab.url.startsWith(base)) throw new Error("That's the bridge itself. Open the site you want agents to explore.");
    const resp = await fetch(`${base}/explore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal, url: tab.url, agents: 3 }) });
    const ex = resp.ok ? await resp.json() : await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(ex.error || resp.statusText || "The bridge refused the request.");
    await chrome.tabs.create({ url: `${base}/explore/${ex.id}` });
    window.close();
  } catch (err) {
    setStatus(err.message || "Couldn't start exploring.", "err");
    $("discover").disabled = false;
  }
}

async function loadWorkflows() {
  const list = $("wfList");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  const base = await bridgeUrl();
  try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch { /* not a web page */ }
  $("wfSite").textContent = host || "";
  try {
    const resp = await fetch(`${base}/workflows${host ? `?site=${encodeURIComponent(host)}` : ""}`);
    const items = await resp.json();
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "wf-empty";
      empty.textContent = host ? `No workflows for ${host} yet. Record one!` : "No workflows yet.";
      list.appendChild(empty);
      return;
    }
    for (const wf of items) {
      const row = document.createElement("div");
      row.className = "wf-item card";
      const info = document.createElement("div");
      const t = document.createElement("div"); t.className = "t"; t.textContent = wf.task;
      const m = document.createElement("div"); m.className = "m"; m.textContent = `${wf.steps} steps · ${wf.recordedBy}`;
      info.append(t, m);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary small";
      btn.textContent = "Guide me";
      btn.addEventListener("click", async () => {
        const r = await chrome.runtime.sendMessage({ type: "GUIDE_ME", id: wf.id, tabId: tab.id, user: await getActiveUser() });
        if (r?.ok) window.close(); else setStatus(r?.error || "Couldn't start the guide.", "err");
      });
      row.append(info, btn);
      list.appendChild(row);
    }
  } catch {
    list.replaceChildren();
    const err = document.createElement("div");
    err.className = "wf-empty";
    err.textContent = `Bridge not reachable at ${base.replace(/^https?:\/\//, "")}.`;
    list.appendChild(err);
  }
}

init();
