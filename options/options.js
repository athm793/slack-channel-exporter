const $ = (id) => document.getElementById(id);

// ── Apps Script template ─────────────────────────────────────────────────────

const APPS_SCRIPT = `function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = "Slack Export";
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    const { headers, rows } = JSON.parse(e.postData.contents);

    // Write header row if sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.setFrozenRows(1);
    }

    // Build a set of every ts (timestamp) already in the sheet for dedup.
    // ts is unique per message; text is not ("+1", "ok", etc. would be wrongly dropped).
    const existingKeys = new Set();
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const tsCol = headerRow.indexOf("ts") + 1; // 1-based column index
      if (tsCol > 0) {
        sheet
          .getRange(2, tsCol, lastRow - 1, 1)
          .getValues()
          .flat()
          .forEach(v => existingKeys.add(String(v)));
      }
    }

    // Only append rows whose ts is not already in the sheet.
    // Also track keys added in this batch to catch intra-batch duplicates.
    const tsIdx = headers.indexOf("ts");
    let appended = 0;
    rows.forEach(row => {
      const key = tsIdx >= 0 ? String(row[tsIdx]) : "";
      if (!existingKeys.has(key)) {
        sheet.appendRow(row);
        existingKeys.add(key);
        appended++;
      }
    });

    return ContentService
      .createTextResponse(JSON.stringify({ ok: true, appended, skipped: rows.length - appended }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextResponse(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}`;

// ── URL parsing ──────────────────────────────────────────────────────────────

function parseSlackUrl(raw) {
  const url = raw.trim();
  if (!url) return null;

  // https://app.slack.com/client/T123/C456
  const clientMatch = url.match(/\/client\/([A-Z0-9]+)\/([A-Z0-9]+)/i);
  if (clientMatch) {
    return {
      teamId: clientMatch[1].toUpperCase(),
      channelId: clientMatch[2].toUpperCase(),
      domain: null,
      label: null,
      raw: url,
    };
  }

  // https://DOMAIN.slack.com/archives/C456
  const archivesMatch = url.match(
    /https?:\/\/([^.]+)\.slack\.com\/archives\/([A-Z0-9]+)/i
  );
  if (archivesMatch) {
    return {
      teamId: null,
      channelId: archivesMatch[2].toUpperCase(),
      domain: archivesMatch[1].toLowerCase(),
      label: null,
      raw: url,
    };
  }

  // Bare channel ID: C01234567
  if (/^[A-Z0-9]{9,11}$/i.test(url)) {
    return { teamId: null, channelId: url.toUpperCase(), domain: null, label: null, raw: url };
  }

  return { error: `Cannot parse: ${url}`, raw: url };
}

function parseAllUrls(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseSlackUrl)
    .filter(Boolean);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderParsedChannels(parsed, savedChannels = []) {
  const container = $("parsed-channels");
  if (!parsed.length) {
    container.innerHTML = '<p class="hint">No channels configured.</p>';
    return;
  }

  container.innerHTML = parsed
    .map((p) => {
      if (p.error) {
        return `<div class="parsed-channel">
          <span class="ch-err">${escHtml(p.error)}</span>
        </div>`;
      }
      const saved = savedChannels.find((s) => s.channelId === p.channelId);
      const nameDisplay = saved?.label ? `#${saved.label}` : (p.channelId || "?");
      const wsLabel = p.domain
        ? `${p.domain}.slack.com`
        : p.teamId
        ? `Team ${p.teamId}`
        : "Any workspace";
      return `<div class="parsed-channel">
        <span>${escHtml(wsLabel)}</span>
        <span class="ch-id">${escHtml(nameDisplay)}</span>
      </div>`;
    })
    .join("");
}

function renderLog(runLog) {
  const container = $("run-log");
  if (!runLog || !runLog.length) {
    container.innerHTML = '<p class="hint">No runs yet.</p>';
    return;
  }

  container.innerHTML = runLog
    .slice(0, 10)
    .map((entry) => {
      const results = (entry.results || [])
        .map((r) => {
          const name = escHtml(r.channel || r.workspace || "?");
          if (r.error) {
            return `<div class="log-result"><span>${name}</span><span class="err">${escHtml(r.error)}</span></div>`;
          }
          if (r.status === "no messages today") {
            return `<div class="log-result"><span>${name}</span><span class="skip">no messages today</span></div>`;
          }
          if (r.status === "ok") {
            const msgs = r.messages != null ? r.messages : "?";
            let dest;
            if (r.sheetsRows != null) {
              const skipNote = r.sheetsSkipped ? `, ${r.sheetsSkipped} dupes skipped` : "";
              dest = `${msgs} msgs → Sheets (+${r.sheetsRows}${skipNote})`;
            } else if (r.file) {
              dest = `${msgs} msgs → ${escHtml(r.file)}`;
            } else {
              dest = `${msgs} msgs`;
            }
            const extra = r.sheetsError
              ? ` <span class="err">${escHtml(r.sheetsError)}</span>`
              : r.downloadError
              ? ` <span class="err">${escHtml(r.downloadError)}</span>`
              : "";
            return `<div class="log-result"><span>${name}</span><span class="ok">${dest}</span>${extra}</div>`;
          }
          // fallback for unknown status
          return `<div class="log-result"><span>${name}</span><span class="skip">${escHtml(r.status || "unknown")}</span></div>`;
        })
        .join("");

      return `<div class="log-entry">
        <div class="log-time">${new Date(entry.time).toLocaleString()}</div>
        ${results || '<span class="skip">No channels ran</span>'}
      </div>`;
    })
    .join("");
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Alarm timing ─────────────────────────────────────────────────────────────

async function updateTimingDisplay() {
  const alarm = await chrome.alarms.get("slack-auto-export");
  $("next-run").textContent = alarm
    ? new Date(alarm.scheduledTime).toLocaleString()
    : "⚠ No alarm — save settings to activate";
  const { lastRun } = await chrome.storage.local.get("lastRun");
  $("last-run").textContent = lastRun ? new Date(lastRun).toLocaleString() : "Never";
}

// ── Status messages ──────────────────────────────────────────────────────────

function showStatus(msg, type = "ok", duration = 6000) {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${type}`;
  setTimeout(() => (el.className = "status hidden"), duration);
}

// ── Init & events ────────────────────────────────────────────────────────────

function applyDestinationToggle(dest) {
  const fileOpts = $("file-options");
  const sheetsOpts = $("sheets-options");
  fileOpts.classList.toggle("hidden", dest === "sheets");
  sheetsOpts.classList.toggle("hidden", dest === "file");
}

async function load() {
  const { channels = [], format = "csv", includeThreads = false, runLog = [],
          destination = "file", sheetsUrl = "", scheduleMinutes = 360, daysBack = 1 } =
    await chrome.storage.local.get(["channels", "format", "includeThreads", "runLog",
                                    "destination", "sheetsUrl", "scheduleMinutes", "daysBack"]);

  $("channel-urls").value = channels.map((c) => c.raw || c.channelId).join("\n");
  $("format-select").value = format;
  $("include-threads").checked = includeThreads;
  $("destination-select").value = destination;
  $("sheets-url").value = sheetsUrl;
  $("schedule-select").value = String(scheduleMinutes);
  $("days-back-select").value = String(daysBack);
  $("apps-script-code").textContent = APPS_SCRIPT;

  applyDestinationToggle(destination);

  const parsed = parseAllUrls($("channel-urls").value);
  renderParsedChannels(parsed, channels);
  renderLog(runLog);
  await updateTimingDisplay();

  // If no alarm exists, the scheduled runs won't happen — re-register it now.
  const alarm = await chrome.alarms.get("slack-auto-export");
  if (!alarm) {
    chrome.runtime.sendMessage({ type: "RESET_ALARM" });
  }
}

// Auto-update log, timing, and channel names whenever the background writes to storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.runLog) renderLog(changes.runLog.newValue || []);
  if (changes.lastRun) updateTimingDisplay();
  if (changes.channels) {
    // Background may have resolved channel names during an export run — refresh display
    const savedChannels = changes.channels.newValue || [];
    const parsed = parseAllUrls($("channel-urls").value);
    renderParsedChannels(parsed, savedChannels);
  }
});

$("destination-select").addEventListener("change", (e) => {
  applyDestinationToggle(e.target.value);
});

$("copy-script-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(APPS_SCRIPT).then(() => {
    $("copy-script-btn").textContent = "Copied!";
    setTimeout(() => ($("copy-script-btn").textContent = "Copy script"), 2000);
  });
});

$("save-btn").addEventListener("click", async () => {
  const text = $("channel-urls").value;
  const parsed = parseAllUrls(text);
  const valid = parsed.filter((p) => !p.error);
  const invalid = parsed.filter((p) => p.error);

  if (invalid.length) {
    showStatus(`${invalid.length} URL(s) could not be parsed. Check the format.`, "error");
    return;
  }

  const destination = $("destination-select").value;
  const sheetsUrl = $("sheets-url").value.trim();

  if ((destination === "sheets" || destination === "both") && sheetsUrl &&
      !sheetsUrl.startsWith("https://script.google.com/")) {
    showStatus("Apps Script URL must start with https://script.google.com/", "error");
    return;
  }

  const format = $("format-select").value;
  const includeThreads = $("include-threads").checked;
  const scheduleMinutes = parseInt($("schedule-select").value, 10);
  const daysBack = parseInt($("days-back-select").value, 10);

  // Read previous state so we can preserve resolved channel names and detect schedule changes
  const { scheduleMinutes: prevSchedule = 360, channels: prevChannels = [] } =
    await chrome.storage.local.get(["scheduleMinutes", "channels"]);

  // Preserve labels that the background resolved during previous export runs
  const channels = valid.map((ch) => {
    const prev = prevChannels.find((p) => p.channelId === ch.channelId);
    return { ...ch, includeThreads, label: prev?.label || null };
  });

  await chrome.storage.local.set({ channels, format, includeThreads, destination, sheetsUrl, scheduleMinutes, daysBack });
  renderParsedChannels(parsed, channels);

  // Only reset the alarm when the interval changed — avoids pushing the next-fire time
  // forward unnecessarily when the user saves other settings.
  const daysLabel = daysBack === 1 ? "today only" : `last ${daysBack} days`;
  if (scheduleMinutes !== prevSchedule) {
    chrome.runtime.sendMessage({ type: "RESET_ALARM" });
    showStatus(`Saved. Schedule changed to every ${scheduleMinutes / 60}h — next run rescheduled.`, "ok", 8000);
  } else {
    const h = scheduleMinutes / 60;
    showStatus(`Saved ${valid.length} channel(s). Runs every ${h}h, fetching ${daysLabel}.`, "ok");
  }
});

$("run-now-btn").addEventListener("click", () => {
  $("run-now-btn").disabled = true;
  $("run-now-btn").textContent = "Running…";
  showStatus("Starting export — this may take a minute…", "ok", 120000);

  chrome.runtime.sendMessage({ type: "RUN_NOW" }, (response) => {
    if (chrome.runtime.lastError) {
      // Service worker died mid-run; log will auto-update via storage.onChanged
      console.warn("[Options] sendMessage error:", chrome.runtime.lastError.message);
    }

    $("run-now-btn").disabled = false;
    $("run-now-btn").textContent = "Run Now";

    // The log has already been updated by storage.onChanged listener.
    // Build a status summary from the latest entry.
    chrome.storage.local.get("runLog").then(({ runLog = [] }) => {
      const latest = runLog[0];
      if (!latest || !latest.results?.length) {
        showStatus("Run complete — no channels configured.", "ok");
        return;
      }

      const results = latest.results;
      const exported = results.filter((r) => r.status === "ok");
      const errors = results.filter((r) => r.error);
      const noNew = results.filter((r) => r.status === "no messages today");

      if (errors.length && !exported.length && !noNew.length) {
        showStatus(`Export failed: ${errors.length} error(s). See log below.`, "error", 8000);
      } else if (exported.length) {
        const totalMsgs = exported.reduce((s, r) => s + (r.messages || 0), 0);
        const file = exported.find((r) => r.file)?.file || "";
        const errNote = errors.length ? `, ${errors.length} error(s)` : "";
        const fileNote = file ? ` → ${file}` : "";
        showStatus(`${totalMsgs} messages from ${exported.length} channel(s)${errNote}.${fileNote}`, "ok", 12000);
      } else if (noNew.length) {
        showStatus("No messages today in any channel.", "ok");
      } else {
        showStatus("Run complete. See log below.", "ok");
      }
    });

    updateTimingDisplay();
  });
});

$("reset-ts-btn").addEventListener("click", async () => {
  if (!confirm("This clears the cached workspace mapping for each channel, forcing a full re-probe next run. Continue?")) return;

  const { channels = [] } = await chrome.storage.local.get("channels");
  const keysToRemove = channels.map((c) => `wsCache_${c.channelId}`);
  await chrome.storage.local.remove(keysToRemove);
  showStatus("Workspace cache cleared. Next run will re-probe all channels.", "ok");
});

// Refresh timing display every minute
setInterval(updateTimingDisplay, 60000);

load();
