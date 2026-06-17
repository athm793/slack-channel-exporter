# Slack Channel Exporter

> **Work in progress** — fully functional for its core use case, with known improvements planned. See the roadmap below.

A Chrome extension that automatically exports Slack channel messages on a configurable schedule. Built for cold outbound agencies and operators who need a record of what's happening in their Slack workspaces — without manually copying anything.

Paste a Slack channel URL, pick your format and destination, set a schedule. The extension handles the rest: downloading files to your machine or appending rows to a Google Sheet every few hours.

**Built for:** outbound agencies, SDR teams, sales ops, and operators managing multiple Slack workspaces who need automated message logging, conversation archives, or data pipelines into Google Sheets.

---

## What it does

- Monitors any number of Slack channels across different workspaces
- Exports messages on a configurable schedule (1h, 6h, 12h, 24h, or custom)
- Sends output to your local machine (CSV/JSON/JSONL download) or directly into a Google Sheet
- Runs silently in the background — no manual triggering needed after setup
- Tracks what it's exported so you don't get duplicate rows

---

## Use cases for agencies and operators

**Conversation logging:** Archive everything said in a client or team Slack channel automatically. Never lose a conversation because someone left the workspace.

**Signal extraction:** Pipe Slack messages into Google Sheets for filtering, tagging, or feeding into other tools. Useful for tracking inbound leads that come in via Slack.

**Audit trails:** Keep a timestamped record of what your team said in key channels — useful for QA, onboarding reviews, or client handoffs.

**Multi-workspace monitoring:** Run exports across channels from different Slack workspaces using a single extension instance.

---

## Features

- **Scheduled auto-export** — configurable interval: 1h, 6h (default), 12h, 24h, or custom
- **Multi-channel support** — add any number of channels from different workspaces
- **Export formats** — CSV, JSON, or JSONL
- **Dual destination** — download locally, post to Google Sheets, or both
- **Thread support** — optionally include thread replies
- **Automatic token rotation** — handles multi-workspace setups by trying all known tokens
- **Deduplication** — prevents duplicate rows when appending to Google Sheets
- **Flexible URL parsing** — accepts `app.slack.com/client/T/C`, `domain.slack.com/archives/C`, or bare channel IDs
- **Run log** — tracks last 10 exports with message counts, errors, and timestamps
- **Live status** — popup shows channel count, last run, next run, and recent results

---

## Installation

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. The extension icon appears in your toolbar

---

## Setup

1. Click the extension icon → **Settings**
2. Paste Slack channel URLs, one per line
3. Choose your export format: CSV, JSON, or JSONL
4. Set your destination: Download / Google Sheets / Both
5. Set your schedule interval
6. Click **Save**, then **Run Now** to confirm it works
7. Done — it runs automatically from here

### Google Sheets setup

In the Settings page, click **Copy Apps Script template** and paste it into a new Apps Script project bound to your target Sheet. Deploy it as a Web App and paste the deployment URL into the extension settings. The script deduplicates rows on append using message timestamps.

---

## How it gets Slack access

The extension does not use OAuth or the Slack API directly. Instead, it injects a script into your open Slack tab that reads the authenticated tokens from `localStorage` — the same tokens your browser is already using to run Slack. Those tokens are used to make API calls from within the page context, which bypasses CORS restrictions.

No credentials are stored externally or sent anywhere. The tokens stay in your browser.

---

## Architecture

```
├── manifest.json
├── background/
│   └── background.js       # Service worker — alarms, export orchestration, Slack API calls
├── content/
│   └── content.js          # Content script — syncs workspace tokens from Slack page
├── injected/
│   └── page-script.js      # Injected into MAIN world — direct Slack localStorage access
├── popup/
│   ├── popup.html          # Quick-access popup (stats + Run Now button)
│   ├── popup.js
│   └── popup.css
└── options/
    ├── options.html        # Full settings page
    ├── options.js
    └── options.css
```

---

## Planned improvements

- **Date range selection** — currently exports from start-of-today. Planning to add configurable lookback windows (last 7 days, last 30 days, or a specific date range)
- **Full history export** — a one-time full-history pull mode, not just the rolling daily window
- **Firefox support** — the extension currently targets Chrome/Chromium only; Firefox MV3 support is on the roadmap
- **Webhook destination** — send exports to a webhook URL (Zapier, Make, n8n) instead of only Google Sheets or local download
- **Per-channel format settings** — set different formats or destinations per channel instead of one global setting
- **UI for token status** — surface which workspace tokens are active, expired, or rate-limited instead of logging only to the run log
- **Smarter rate limit handling** — currently marks a token as exhausted on a 429 and rotates; the plan is to implement backoff and retry instead

---

## Stack

| Layer | Technology |
|---|---|
| Extension model | Chrome Manifest V3 |
| Background | Service Worker |
| Language | Vanilla JavaScript (no build step) |
| Storage | `chrome.storage.local` |
| Slack API access | Injected page-context script |
| Google Sheets | Apps Script Web App |
