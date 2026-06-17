// Service worker: configurable alarm + scheduled export.
// Uses chrome.scripting.executeScript with world:"MAIN" to run API calls
// directly in the page context — no postMessage bridge, no timeouts.

const ALARM_NAME = "slack-auto-export";
const BADGE_CLEAR_ALARM = "slack-badge-clear";

// ── Alarm ────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => setupAlarm());
chrome.runtime.onStartup.addListener(() => setupAlarm());

// Read schedule from storage. Never hardcode — always defer to what the user saved.
async function getScheduleMinutes() {
  const { scheduleMinutes = 360 } = await chrome.storage.local.get("scheduleMinutes");
  return Number(scheduleMinutes) || 360;
}

async function setupAlarm() {
  const periodInMinutes = await getScheduleMinutes();
  const existing = await chrome.alarms.get(ALARM_NAME);
  // Only recreate if the alarm is missing or has the wrong period.
  // Leaving a correct alarm untouched preserves the next-fire time.
  if (existing?.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes });
}

async function forceResetAlarm() {
  // Always clear and recreate — used when the user explicitly changes the schedule.
  await chrome.alarms.clear(ALARM_NAME);
  const periodInMinutes = await getScheduleMinutes();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await runScheduledExport();
  if (alarm.name === BADGE_CLEAR_ALARM) chrome.action.setBadgeText({ text: "" });
});

// ── Tab management ───────────────────────────────────────────────────────────

let openedTabId = null;

async function getBestSlackTab() {
  // Prefer app.slack.com (modern Slack — all workspaces accessible from one tab)
  const appTabs = await chrome.tabs.query({ url: "https://app.slack.com/*" });
  const appLive = appTabs.filter((t) => t.url && !t.url.includes("/sign_in"));
  if (appLive.length) return appLive[0];

  // Fall back to any open workspace-specific tab
  const allTabs = await chrome.tabs.query({ url: "https://*.slack.com/*" });
  const allLive = allTabs.filter(
    (t) => t.url && !t.url.includes("/ssb/") && !t.url.includes("/sign_in")
  );
  if (allLive.length) return allLive[0];

  // Nothing open — open app.slack.com silently
  const tab = await chrome.tabs.create({ url: "https://app.slack.com", active: false });
  openedTabId = tab.id;
  await new Promise((resolve) => {
    let settled = false;
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        settled = true;
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (!settled) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, 25000);
  });
  await sleep(3000);
  return chrome.tabs.get(tab.id);
}

// ── Page script execution ────────────────────────────────────────────────────

async function injectPageScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["injected/page-script.js"],
  });
}

async function runInPage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  if (!results?.length) throw new Error("executeScript returned no results — tab may have navigated");
  const r = results[0];
  // Chrome sets r.error only for script execution errors, not application errors
  if (r?.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r?.result;
}

// ── Workspace sync ───────────────────────────────────────────────────────────

async function syncWorkspaces(tabId) {
  await injectPageScript(tabId);

  let workspaces = await runInPage(tabId, () => {
    if (!window.__slackExporter) return null; // injection guard fired, signal retry
    return window.__slackExporter.getWorkspaces();
  });

  if (workspaces === null) {
    // Reset the guard and re-inject so the exporter is redefined
    await runInPage(tabId, () => { window.__slackExporterPage = false; });
    await injectPageScript(tabId);
    workspaces = await runInPage(tabId, () =>
      window.__slackExporter?.getWorkspaces() ?? []
    );
  }

  if (workspaces?.length) {
    await chrome.storage.local.set({ workspaces });
    return workspaces;
  }

  // Fall back to workspaces saved by content.js on last page load
  const { workspaces: stored = [] } = await chrome.storage.local.get("workspaces");
  if (stored.length) {
    console.warn("[Slack Exporter] Page script returned no workspaces — using cached list.");
  }
  return stored;
}

// ── Per-channel export with workspace probing ────────────────────────────────

// Errors that mean "wrong workspace, try the next one"
const WRONG_WS_ERRORS = [
  "channel_not_found",
  "not_in_channel",
  "No token",
  "Token error",
  "account_inactive",
  // NOTE: ratelimited is NOT here — it means "slow down on this workspace", not "wrong workspace"
];

function isWrongWorkspace(errMsg) {
  return WRONG_WS_ERRORS.some((e) => errMsg.includes(e));
}

function getOldestTs(daysBack = 1) {
  const d = new Date();
  d.setHours(0, 0, 0, 0); // start of today (local midnight)
  d.setDate(d.getDate() - (daysBack - 1)); // go back N-1 additional days
  return String(Math.floor(d.getTime() / 1000));
}

// Returns { rows, wsName, workspace, channelName } on success, or { status } or { error }
async function fetchChannelRows(ch, workspaces, tabId, daysBack = 1) {
  const cacheKey = `wsCache_${ch.channelId}`;
  const { [cacheKey]: cachedDomain } = await chrome.storage.local.get(cacheKey);
  const hintDomain = ch.domain || workspaces.find((w) => w.teamId === ch.teamId)?.domain;
  const allDomains = workspaces.map((w) => w.domain).filter(Boolean);

  const ordered = [cachedDomain, hintDomain, ...allDomains]
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i);

  const oldest = getOldestTs(daysBack);

  for (const targetDomain of ordered) {
    let result;
    try {
      result = await runInPage(
        tabId,
        async (channelId, targetDomain, oldest, includeThreads) => {
          try {
            const rows = await window.__slackExporter.exportChannel(
              channelId, targetDomain, oldest, includeThreads
            );
            return { ok: true, rows };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
        [ch.channelId, targetDomain, oldest, ch.includeThreads || false]
      );
    } catch (err) {
      return { error: "Script error: " + err.message };
    }

    if (!result?.ok) {
      const err = result?.error || "";
      if (isWrongWorkspace(err)) continue;
      return { error: `[${targetDomain}] ${err}` };
    }

    await chrome.storage.local.set({ [cacheKey]: targetDomain });

    // Resolve channel name (best-effort — never blocks the export)
    let channelName = null;
    try {
      const info = await runInPage(
        tabId,
        async (channelId, domain) => {
          try { return await window.__slackExporter.getChannelInfo(channelId, domain); }
          catch { return null; }
        },
        [ch.channelId, targetDomain]
      );
      channelName = info?.name || null;
    } catch {}

    const rows = result.rows;
    if (!rows.length) return { status: "no messages today", workspace: targetDomain, channelName };

    const ws = workspaces.find((w) => w.domain === targetDomain) || { teamName: targetDomain, domain: targetDomain };
    return { rows, wsName: ws.teamName || ws.domain, workspace: targetDomain, channelName };
  }

  return { error: "Channel not found in any workspace" };
}

// ── Main export run ──────────────────────────────────────────────────────────

async function runScheduledExport() {
  const { channels: configuredChannels = [], format = "csv", destination = "file", sheetsUrl = "", daysBack = 1 } =
    await chrome.storage.local.get(["channels", "format", "destination", "sheetsUrl", "daysBack"]);

  if (!configuredChannels.length) return;

  openedTabId = null;
  let tab;
  try {
    tab = await getBestSlackTab();
  } catch (err) {
    console.error("[Slack Exporter] No Slack tab available:", err.message);
    await writeRunLog([{ channel: "—", error: "No Slack tab available: " + err.message }]);
    return;
  }

  let workspaces;
  try {
    workspaces = await syncWorkspaces(tab.id);
  } catch (err) {
    console.error("[Slack Exporter] Failed to sync workspaces:", err.message);
    if (openedTabId) await chrome.tabs.remove(openedTabId).catch(() => {});
    await writeRunLog([{ channel: "—", error: "Workspace sync failed: " + err.message }]);
    return;
  }

  if (!workspaces.length) {
    console.error("[Slack Exporter] No workspaces found.");
    if (openedTabId) await chrome.tabs.remove(openedTabId).catch(() => {});
    await writeRunLog([{ channel: "—", error: "No workspaces found in localStorage" }]);
    return;
  }

  const log = [];
  const allRows = [];
  let channelsUpdated = false;

  for (const ch of configuredChannels) {
    const result = await fetchChannelRows(ch, workspaces, tab.id, daysBack);

    // Persist resolved channel name so options/popup can display it
    if (result.channelName && !ch.label) {
      ch.label = result.channelName;
      channelsUpdated = true;
    }

    const channelLabel = ch.label || ch.channelId;

    if (result.error) {
      log.push({ channel: channelLabel, error: result.error });
      console.log("[Slack Exporter]", ch.channelId, result.error);
    } else if (result.status === "no messages today") {
      log.push({ channel: channelLabel, status: "no messages today", workspace: result.workspace });
      console.log("[Slack Exporter]", ch.channelId, "no messages today");
    } else {
      // Prepend workspace and channel columns to each row
      for (const row of result.rows) {
        allRows.push({ workspace: result.wsName, channel: channelLabel, ...row });
      }
      log.push({ channel: channelLabel, messages: result.rows.length, status: "ok", workspace: result.workspace });
      console.log("[Slack Exporter]", ch.channelId, result.rows.length, "messages");
    }

    await sleep(500);
  }

  // Write back resolved channel names (only when something changed)
  if (channelsUpdated) {
    await chrome.storage.local.set({ channels: configuredChannels });
  }

  if (openedTabId) {
    await chrome.tabs.remove(openedTabId).catch(() => {});
    openedTabId = null;
  }

  if (allRows.length) {
    const date = new Date().toLocaleDateString("sv"); // YYYY-MM-DD

    // ── Download file ────────────────────────────────────────────────────────
    if (destination === "file" || destination === "both") {
      const filename = `slack_export_${date}.${format}`;
      try {
        await downloadFile(formatRows(allRows, format), filename, format);
        for (const entry of log) {
          if (entry.status === "ok") entry.file = filename;
        }
      } catch (dlErr) {
        for (const entry of log) {
          if (entry.status === "ok") entry.downloadError = "Download failed: " + dlErr.message;
        }
      }
    }

    // ── Post to Google Sheet ─────────────────────────────────────────────────
    if ((destination === "sheets" || destination === "both") && sheetsUrl) {
      try {
        const { appended, skipped } = await postToSheets(sheetsUrl, allRows);
        for (const entry of log) {
          if (entry.status === "ok") {
            entry.sheetsRows = appended;
            entry.sheetsSkipped = skipped;
          }
        }
      } catch (sheetErr) {
        for (const entry of log) {
          if (entry.status === "ok") entry.sheetsError = "Sheets failed: " + sheetErr.message;
        }
      }
    }
  }

  await writeRunLog(log);
  updateBadge(log);
}

async function postToSheets(url, rows) {
  const headers = Object.keys(rows[0]);
  const rowArrays = rows.map((row) => headers.map((h) => String(row[h] ?? "")));

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ headers, rows: rowArrays }),
    redirect: "follow",
  });

  if (!resp.ok) throw new Error("HTTP " + resp.status);

  const text = await resp.text();

  // Apps Script POST responses travel through a Google redirect.
  // fetch follows the 302 as a GET, which returns an HTML page — but the
  // doPost already ran and the sheet was updated. Treat as success.
  if (text.trimStart().startsWith("<")) {
    return { appended: rows.length, skipped: 0 };
  }

  const data = JSON.parse(text);
  if (!data.ok) throw new Error(data.error || "Unknown error from Apps Script");
  return { appended: data.appended, skipped: data.skipped ?? 0 };
}

async function writeRunLog(results) {
  const now = new Date().toISOString();
  const { runLog = [] } = await chrome.storage.local.get("runLog");
  runLog.unshift({ time: now, results });
  if (runLog.length > 50) runLog.splice(50);
  await chrome.storage.local.set({ lastRun: now, runLog });
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatRows(rows, format) {
  if (format === "json") return JSON.stringify(rows, null, 2);
  if (format === "jsonl") return rows.map((r) => JSON.stringify(r)).join("\n");
  return toCsv(rows);
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

// ── Download ─────────────────────────────────────────────────────────────────

async function downloadFile(content, filename, format) {
  const mime = { csv: "text/csv", json: "application/json", jsonl: "text/plain" }[format] || "text/plain";
  const dataUrl = `data:${mime};charset=utf-8,` + encodeURIComponent(content);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      if (downloadId === undefined) {
        reject(new Error(chrome.runtime.lastError?.message || "unknown error"));
      } else {
        resolve(downloadId);
      }
    });
  });
}

// ── Badge ────────────────────────────────────────────────────────────────────

function updateBadge(log) {
  const errors = log.filter((l) => l.error).length;
  chrome.action.setBadgeText({ text: errors ? "!" : "✓" });
  chrome.action.setBadgeBackgroundColor({ color: errors ? "#e01e5a" : "#2bac76" });
  // Use a one-shot alarm instead of setTimeout — setTimeout is unreliable in MV3 service workers
  // because the SW can be terminated before it fires.
  chrome.alarms.create(BADGE_CLEAR_ALARM, { delayInMinutes: 10 });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "RUN_NOW") {
    runScheduledExport()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep message channel open
  }
  if (msg.type === "RESET_ALARM") {
    forceResetAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});
