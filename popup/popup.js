const $ = (id) => document.getElementById(id);

function relativeTime(isoStr) {
  if (!isoStr) return "Never";
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeUntil(scheduledTime) {
  if (!scheduledTime) return "—";
  const diff = scheduledTime - Date.now();
  if (diff < 0) return "soon";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function load() {
  const { channels = [], lastRun, runLog = [], scheduleMinutes = 360 } =
    await chrome.storage.local.get(["channels", "lastRun", "runLog", "scheduleMinutes"]);

  $("channel-count").textContent = channels.length;
  $("last-run").textContent = relativeTime(lastRun);

  const alarm = await chrome.alarms.get("slack-auto-export");
  $("next-run").textContent = alarm ? timeUntil(alarm.scheduledTime) : "—";

  const h = scheduleMinutes / 60;
  $("schedule-badge").textContent = `Every ${Number.isInteger(h) ? h + "h" : scheduleMinutes + "m"}`;

  if (!channels.length) {
    $("no-channels").classList.remove("hidden");
  } else {
    $("no-channels").classList.add("hidden");
  }

  // Show last run results
  const lastEntry = runLog[0];
  const container = $("last-results");
  if (lastEntry && lastEntry.results?.length) {
    container.innerHTML = lastEntry.results
      .slice(0, 5)
      .map((r) => {
        const name = r.channel || r.workspace || "?";
        let statusHtml;
        if (r.error) statusHtml = `<span class="err">error</span>`;
        else if (r.status === "no messages today") statusHtml = `<span class="skip">quiet today</span>`;
        else if (r.status === "ok") statusHtml = `<span class="ok">+${r.messages ?? "?"}</span>`;
        else statusHtml = `<span class="skip">${r.status || "?"}</span>`;
        return `<div class="result-row"><span class="ch">${name}</span>${statusHtml}</div>`;
      })
      .join("");
  } else {
    container.innerHTML = "";
  }
}

// Auto-refresh popup when storage changes (background writes runLog / lastRun)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.runLog || changes.lastRun)) load();
});

$("settings-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

$("run-now-btn").addEventListener("click", () => {
  $("run-now-btn").disabled = true;
  $("run-now-btn").textContent = "Running…";

  chrome.runtime.sendMessage({ type: "RUN_NOW" }, () => {
    // Ignore lastError — storage.onChanged will refresh the popup automatically
    void chrome.runtime.lastError;
    $("run-now-btn").disabled = false;
    $("run-now-btn").textContent = "Run Now";
    load();
  });
});

load();
