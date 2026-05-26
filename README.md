# Rewards Playwright 🚀

Automated multi-session browsing with Playwright to run Bing searches with Microsoft Edge. This repo launches two desktop Edge browsers in parallel, completes their searches, and then launches two mobile-emulated Edge sessions using their own stored mobile sessions.

## ✨ Features
- **Parallel desktop runs**: Two Microsoft Edge instances run at the same time.
- **Sequenced mobile runs**: Two iPhone 13–emulated Edge sessions start after both desktop runs finish.
- **Validated session reuse**: Desktop sessions first validate the existing Edge-specific `storage-*-edge.json` files and skip login when the stored state is still usable.
- **Dedicated mobile storage**: Mobile runs reuse `storage-user*-edge-mobile.json` when available. If a mobile storage file is missing or unusable, the run starts a clean mobile session, signs in with credentials, and saves the mobile state.
- **Verbose runtime logging**: Live logs show storage reuse decisions, cookie validity summaries, login steps, desktop/mobile search counters, cooldowns, and reloads.
- **Configurable via .env**: Control credentials and search settings without code changes.
- **Resilient sign-in flow**: Handles cookies, remembered-account pickers, and typical Microsoft post‑login prompts (e.g., "Yes", "Skip for now").

## 📁 Repository Structure
- `tests/rewards.spec.ts` – Main Playwright test orchestrating the desktop → mobile flow.
- `playwright.config.ts` – Playwright configuration (reporters, timeouts, etc.).
- `.env.example` – Example environment variables to copy into `.env`.
- `.gitignore` – Ensures sensitive files (like `.env`) aren’t committed.

## ✅ Prerequisites
- Node.js 18+ recommended.
- Playwright browsers installed.

The project has a postinstall script to install Playwright browsers with system dependencies:

```bash
npm install
```

If you’re on Linux and you don’t want to install system dependencies (or see errors), you can run:

```bash
npx playwright install
```

…or only Microsoft Edge:

```bash
npx playwright install msedge
```

## 🔐 Environment Setup
Copy `.env.example` to `.env` and fill in your credentials and preferences:

```bash
cp .env.example .env
```

`.env` keys used in `tests/rewards.spec.ts`:

- `USER1` – Email/username for account 1
- `PASS1` – Password for account 1
- `USER2` – Email/username for account 2
- `PASS2` – Password for account 2
- `BROWSER_CHANNEL` – Optional Playwright Chromium channel override; defaults to `msedge`
- `RUN_DESKTOP_SEARCHES` – Enable or disable the desktop phase; defaults to `true`
- `RUN_MOBILE_SEARCHES` – Enable or disable the mobile phase; defaults to `true`
- `DESKTOP_SEARCHES` – Number of searches per desktop session (default example: 32)
- `DESKTOP_DURATION_WINDOW_ENABLED` – Enable or disable spreading desktop searches across the configured duration window; defaults to `true`
- `DESKTOP_RUN_MINUTES_MIN` – Minimum desktop run duration in minutes; defaults to 30
- `DESKTOP_RUN_MINUTES_MAX` – Maximum desktop run duration in minutes; defaults to 40
- `MOBILE_SEARCHES` – Number of searches per mobile session (default example: 22)
- `WAIT_MS` – Wait time in milliseconds for wait/cooldown schedules
- `COOLDOWN_EVERY` – After how many searches to apply a cooldown pause (default example: 4)
- `COOLDOWN_MS` – Cooldown duration in milliseconds for wait/cooldown schedules
- `KEYWORD_SEARCH` – Keyword to search for (default example: "cat")

> Note: `.env` is ignored by Git. Do not commit your real credentials.

## ▶️ Running the Tests
Headed (visible):

```bash
npx playwright test tests/rewards.spec.ts --headed
```

Headless (CI‑style):

```bash
npx playwright test tests/rewards.spec.ts
```

Examples:

```bash
RUN_DESKTOP_SEARCHES=false npx playwright test tests/rewards.spec.ts
RUN_MOBILE_SEARCHES=false DESKTOP_DURATION_WINDOW_ENABLED=false npx playwright test tests/rewards.spec.ts
```

To override credentials without a `.env` file:

```bash
USER1='user1@example.com' PASS1='password1' USER2='user2@example.com' PASS2='password2' npx playwright test tests/rewards.spec.ts
```

The run now prints live progress to stdout, including enabled/disabled phases, phase concurrency, whether stored cookies will be reused, how many valid cookies were found, the current desktop/mobile search number, and the exact next-search timestamp after each scheduled pause.

## ⚙️ How It Works
1. Loads credentials and configuration using `dotenv`.
2. Creates an API client to fetch random words from `https://api.datamuse.com/`.
3. If `RUN_DESKTOP_SEARCHES=true`, launches two desktop Microsoft Edge sessions in parallel.
   - Navigates to `https://bing.com/`
   - Accepts cookies if prompted
   - Reuses `storage-user*-edge.json` when it is still valid; otherwise starts a clean Edge session and signs in with `USER1` and `USER2`
   - Performs exactly `DESKTOP_SEARCHES` random queries
   - If `DESKTOP_DURATION_WINDOW_ENABLED=true`, spreads those searches across a randomly selected `DESKTOP_RUN_MINUTES_MIN` to `DESKTOP_RUN_MINUTES_MAX` window
   - If `DESKTOP_DURATION_WINDOW_ENABLED=false`, uses only `WAIT_MS`, `COOLDOWN_EVERY`, and `COOLDOWN_MS` for timing
   - Saves storage state to `storage-user1-edge.json` and `storage-user2-edge.json`
4. If `RUN_MOBILE_SEARCHES=true`, launches two iPhone 13–emulated sessions in parallel after the desktop phase finishes.
   - Reuses `storage-user1-edge-mobile.json` and `storage-user2-edge-mobile.json` when valid
   - If mobile storage is missing or unusable, starts without stored cookies, signs in with credentials, and saves the mobile JSON after login
   - Performs `MOBILE_SEARCHES` random queries with dynamically scheduled pauses and optional page reloads

## 🗂️ Storage State
- Desktop Edge auth states are persisted to `storage-user1-edge.json` and `storage-user2-edge.json` in the project root.
- Mobile Edge auth states are persisted separately to `storage-user1-edge-mobile.json` and `storage-user2-edge-mobile.json`.
- When those files still contain usable cookies and the session is actually signed in, the matching desktop or mobile flow reuses them instead of forcing a new login.
- If an Edge storage file is present but no longer signs in correctly, the script starts a clean Edge context and replaces that storage file after login.
- These files are ignored by Git to protect your sessions.

## 🧩 Tips
- If Bing or Microsoft sign‑in flows change element IDs or text, you may need to adjust selectors in `tests/rewards.spec.ts`.
- You can tune `DESKTOP_SEARCHES`, `MOBILE_SEARCHES`, and timing values in `.env` to fit your strategy.

## 🛠️ Troubleshooting
- "Cannot find module 'dotenv/config'":
  - Run `npm install` to install dependencies.
- Postinstall failure on Linux (e.g., apt key or repo errors) when running `npm install`:
  - Try installing browsers without system deps: `npx playwright install`
  - Or install only Edge: `npx playwright install msedge`
  - Alternatively, manually install required system packages listed in Playwright docs, then rerun `npm install`.
- Sudo prompt during `--with-deps`:
  - Playwright’s `--with-deps` installs OS dependencies using your package manager. If that’s undesirable, omit `--with-deps` and ensure required libraries are installed.

## 🔒 Security
- Do not share or commit your `.env`.
- Consider using environment variables or a secure secrets manager in CI environments.

## 📜 License
This project is provided as‑is; add your preferred license if needed.
