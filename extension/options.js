const $ = (id) => document.getElementById(id);

async function load() {
  const { bridgeUrl } = await chrome.storage.local.get("bridgeUrl");
  $("bridgeUrl").value = bridgeUrl || "";
}

async function save() {
  const bridgeUrl = $("bridgeUrl").value.trim().replace(/\/+$/, "");
  if (bridgeUrl && !/^https?:\/\//i.test(bridgeUrl)) {
    $("status").textContent = "The bridge URL needs to start with http:// or https://.";
    return;
  }
  await chrome.storage.local.set({ bridgeUrl });
  $("status").textContent = "Saved.";
  setTimeout(() => { $("status").textContent = ""; }, 1500);
}

$("save").addEventListener("click", save);
load();
