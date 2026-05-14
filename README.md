# Slack Channel Exporter — Chrome Extension

A Chrome extension that automatically exports Slack channel messages on a configurable schedule. Paste any Slack channel URL, choose your export format and destination, and the extension handles the rest — downloading files to your machine or appending rows to a Google Sheet every few hours.

## Features

- **Scheduled auto-export** — configurable interval: 1h, 6h (default), 12h, 24h, or custom
- **Multi-channel support** — add any number of channels from different workspaces
- **Export formats** — CSV, JSON, or JSONL
- **Dual destination** — download files locally and/or post to Google Sheets
- **Thread support** — optional inclusion of thread replies
- **Automatic token rotation** — tries all workspace tokens if channels span multiple workspaces
- **Deduplication** — prevents duplicate rows when appending to Google Sheets
- **URL parsing** — accepts multiple Slack URL formats (`app.slack.com/client/T/C`, `domain.slack.com/archives/C`, or bare channel IDs)
- **Run log** — tracks last 10 exports with message counts, errors, and timestamps
- **Live status** — popup shows channel count, last run, next run, and recent results

## Stack

| Layer | Technology |
|---|---|
| Extension model | Chrome Manifest V3 |
| Background | Service Worker |
| Language | JavaScript (vanilla, no build step) |
| Storage | `chrome.storage.local` |
| Slack API access | Injected page-context script (bypasses CORS) |
| Google Sheets | Apps Script Web App integration |

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. The extension icon appears in your toolbar

## Usage

1. Click the extension icon → **Settings**
2. Paste Slack channel URLs (one per line)
3. Choose export format (CSV / JSON / JSONL)
4. Set destination: Download / Google Sheets / Both
5. Configure your schedule interval
6. Click **Save**, then **Run Now** to test
7. The extension auto-runs on schedule from then on

## Google Sheets Setup

In the Settings page, click **Copy Apps Script template** and paste it into a new Apps Script project bound to your target Sheet. Deploy as a Web App and paste the deployment URL into the extension settings. The script deduplicates rows on append using message timestamps.

## Architecture

```
├── manifest.json
├── background/
│   └── background.js       # Service worker — alarms, export orchestration, Slack API calls
├── content/
│   └── content.js          # Content script — syncs workspace tokens from Slack page
├── injected/
│   └── page-script.js      # Injected into page MAIN world — direct Slack API access
├── popup/
│   ├── popup.html          # Quick-access popup (stats + Run Now button)
│   ├── popup.js
│   └── popup.css
└── options/
    ├── options.html        # Full settings page
    ├── options.js
    └── options.css
```

## How Slack API Access Works

Rather than calling the Slack API directly (which would fail due to CORS), the extension injects `page-script.js` into the Slack tab's MAIN world. This script reads Slack's `localConfig_v2` from `localStorage` — which contains authenticated workspace tokens — and exposes a `window.__slackExporter` API that `background.js` calls via `chrome.scripting.executeScript`. No credentials are stored externally.

## Key Implementation Notes

- **Token extraction** — reads `localConfig_v2` from Slack's `localStorage` for authenticated tokens
- **Workspace probing** — tries cached domain → hint domain → all registered domains per channel
- **Rate limiting** — handles 429s by marking tokens exhausted and rotating to the next workspace
- **Message window** — exports messages from start-of-today onwards (no full history pull)
- **Alarm management** — only recreates the Chrome alarm if the interval changes; preserves next-fire time otherwise
