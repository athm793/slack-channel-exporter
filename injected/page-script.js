// Injected into page MAIN world by the background via chrome.scripting.executeScript.
// Exposes window.__slackExporter — no postMessage needed.

(function () {
  if (window.__slackExporterPage) return;
  window.__slackExporterPage = true;

  function getTokenForDomain(targetDomain) {
    const raw = localStorage.getItem("localConfig_v2");
    if (!raw) throw new Error("localConfig_v2 not in localStorage");
    const teams = JSON.parse(raw).teams || {};
    const entry = Object.entries(teams).find(([, t]) => t.domain === targetDomain);
    if (!entry?.[1]?.token) throw new Error("No token for domain: " + targetDomain);
    return entry[1].token;
  }

  function getWorkspaces() {
    try {
      const raw = localStorage.getItem("localConfig_v2");
      if (!raw) return [];
      const teams = JSON.parse(raw).teams || {};
      return Object.entries(teams)
        .filter(([, t]) => t.token)
        .map(([teamId, t]) => ({
          teamId,
          teamName: t.name || t.team_name || t.domain || "",
          domain: t.domain || "",
        }));
    } catch { return []; }
  }

  async function slackGet(endpoint, targetDomain, params = {}) {
    const token = getTokenForDomain(targetDomain);
    const url = new URL(`${location.origin}/api/${endpoint}`);
    url.searchParams.set("token", token);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data.ok) throw new Error("Slack error: " + data.error);
    return data;
  }

  async function fetchMessages(channelId, oldest, latest, targetDomain) {
    const messages = [];
    let cursor = "";
    do {
      const data = await slackGet("conversations.history", targetDomain, {
        channel: channelId, limit: 200,
        cursor: cursor || undefined,
        oldest: oldest || undefined,
        latest: latest || undefined,
      });
      messages.push(...(data.messages || []));
      cursor = data.response_metadata?.next_cursor || "";
    } while (cursor);
    return messages;
  }

  async function fetchReplies(channelId, threadTs, targetDomain) {
    const replies = [];
    let cursor = "";
    do {
      const data = await slackGet("conversations.replies", targetDomain, {
        channel: channelId, ts: threadTs, limit: 200,
        cursor: cursor || undefined,
      });
      replies.push(...(data.messages || []));
      cursor = data.response_metadata?.next_cursor || "";
    } while (cursor);
    return replies.slice(1);
  }

  const userCache = {};
  async function resolveUser(userId, targetDomain) {
    if (!userId) return "";
    const key = targetDomain + ":" + userId;
    if (userCache[key]) return userCache[key];
    try {
      const data = await slackGet("users.info", targetDomain, { user: userId });
      const name = data.user?.profile?.display_name || data.user?.profile?.real_name || data.user?.name || userId;
      userCache[key] = name;
      return name;
    } catch {
      userCache[key] = userId;
      return userId;
    }
  }

  function tsToDatetime(ts) {
    return new Date(parseFloat(ts) * 1000).toISOString().replace("T", " ").slice(0, 19);
  }

  window.__slackExporter = {
    getWorkspaces,

    async getChannelInfo(channelId, targetDomain) {
      try {
        const data = await slackGet("conversations.info", targetDomain, { channel: channelId });
        return {
          name: data.channel?.name || null,
          isPrivate: data.channel?.is_private || false,
        };
      } catch {
        return { name: null };
      }
    },

    async listChannels(targetDomain) {
      const channels = [];
      let cursor = "";
      do {
        const data = await slackGet("conversations.list", targetDomain, {
          types: "public_channel,private_channel",
          exclude_archived: true, limit: 200,
          cursor: cursor || undefined,
        });
        channels.push(...(data.channels || []));
        cursor = data.response_metadata?.next_cursor || "";
      } while (cursor);
      return channels.map((c) => ({ id: c.id, name: c.name, isPrivate: c.is_private }));
    },

    async exportChannel(channelId, targetDomain, oldest, includeThreads) {
      const rawMessages = await fetchMessages(channelId, oldest, null, targetDomain);
      const rows = [];
      for (const m of rawMessages) {
        rows.push({
          ts: m.ts,
          datetime: tsToDatetime(m.ts),
          user_id: m.user || "",
          username: await resolveUser(m.user, targetDomain),
          text: (m.text || "").replace(/\n/g, " "),
          thread_ts: m.thread_ts || "",
          reply_count: m.reply_count || 0,
          reactions: (m.reactions || []).map((r) => `${r.name}(${r.count})`).join(", "),
          is_reply: false,
        });
        if (includeThreads && m.thread_ts && m.reply_count > 0) {
          const replies = await fetchReplies(channelId, m.thread_ts, targetDomain);
          for (const r of replies) {
            rows.push({
              ts: r.ts,
              datetime: tsToDatetime(r.ts),
              user_id: r.user || "",
              username: await resolveUser(r.user, targetDomain),
              text: (r.text || "").replace(/\n/g, " "),
              thread_ts: r.thread_ts || "",
              reply_count: 0, reactions: "", is_reply: true,
            });
          }
        }
      }
      rows.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
      return rows;
    },
  };
})();
