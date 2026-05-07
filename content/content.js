// Content script: syncs workspace list to chrome.storage on page load.
// All API calls now go through background.js → executeScript(world:"MAIN") directly.

(function () {
  if (window.__slackExporterCS) return;
  window.__slackExporterCS = true;

  // Read workspaces from localStorage and store them so the popup/options can use them
  function syncWorkspaces() {
    try {
      const raw = localStorage.getItem("localConfig_v2");
      if (!raw) return;
      const teams = JSON.parse(raw).teams || {};
      const workspaces = Object.entries(teams)
        .filter(([, t]) => t.token)
        .map(([teamId, t]) => ({
          teamId,
          teamName: t.name || t.team_name || t.domain || "",
          domain: t.domain || "",
        }));
      if (workspaces.length) {
        chrome.storage.local.set({ workspaces });
      }
    } catch {}
  }

  setTimeout(syncWorkspaces, 1500);
})();
