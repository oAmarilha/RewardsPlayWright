# Rewards Playwright 🚀

Automated multi-session browsing with Playwright to run Bing searches and collect rewards more efficiently. This repo launches two desktop browsers in parallel, completes their searches, and then launches two mobile-emulated browsers reusing the same authenticated sessions.

## ✨ Features
- **Parallel desktop runs**: Two Chromium instances run at the same time.
- **Sequenced mobile runs**: Two iPhone 13–emulated sessions start after both desktop runs finish.
- **Validated session reuse**: Desktop sessions first validate the existing `storage-*.json` files and skip login when the stored state is still usable.
- **Mobile session refresh**: Mobile runs start from the desktop storage state, sign out inside the mobile tab, then sign back in through the mobile UI so the session is refreshed for the mobile viewport.
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

…or only the needed browser(s):

```bash
npx playwright install chromium
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
- `DESKTOP_SEARCHES` – Number of searches per desktop session (default example: 32)
- `MOBILE_SEARCHES` – Number of searches per mobile session (default example: 22)
- `WAIT_MS` – Wait time in milliseconds between searches (default example: 10000)
- `COOLDOWN_EVERY` – After how many searches to apply a cooldown pause (default example: 4)
- `COOLDOWN_MS` – Cooldown duration in milliseconds (default example: 1830000)
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

To override credentials without a `.env` file:

```bash
USER1='user1@example.com' PASS1='password1' USER2='user2@example.com' PASS2='password2' npx playwright test tests/rewards.spec.ts
```

The run now prints live progress to stdout, including whether stored cookies will be reused, how many valid cookies were found, which login path was taken, and the current desktop/mobile search number.

## ⚙️ How It Works
1. Loads credentials and configuration using `dotenv`.
2. Creates an API client to fetch random words from `https://api.datamuse.com/`.
3. Launches two desktop Chromium sessions in parallel.
   - Navigates to `https://bing.com/`
   - Accepts cookies if prompted
   - Reuses `storage-user*.json` when it is still valid; otherwise signs in with `USER1` and `USER2`
   - Performs `DESKTOP_SEARCHES` random queries
   - Saves storage state to `storage-user1.json` and `storage-user2.json`
4. Launches two iPhone 13–emulated sessions in parallel.
   - Loads the saved desktop storage state
   - Signs out in the mobile tab, then signs back in from the mobile UI so Microsoft refreshes the session for mobile
   - Performs `MOBILE_SEARCHES` random queries (with optional page reloads)

## 🗂️ Storage State
- Auth states are persisted to `storage-user1.json` and `storage-user2.json` in the project root.
- When those files still contain usable cookies, the desktop flow reuses them instead of forcing a new login.
- These files are ignored by Git to protect your sessions.

## 🧩 Tips
- If Bing or Microsoft sign‑in flows change element IDs or text, you may need to adjust selectors in `tests/rewards.spec.ts`.
- You can tune `DESKTOP_SEARCHES`, `MOBILE_SEARCHES`, and timing values in `.env` to fit your strategy.

## 🛠️ Troubleshooting
- "Cannot find module 'dotenv/config'":
  - Run `npm install` to install dependencies.
- Postinstall failure on Linux (e.g., apt key or repo errors) when running `npm install`:
  - Try installing browsers without system deps: `npx playwright install`
  - Or install only Chromium: `npx playwright install chromium`
  - Alternatively, manually install required system packages listed in Playwright docs, then rerun `npm install`.
- Sudo prompt during `--with-deps`:
  - Playwright’s `--with-deps` installs OS dependencies using your package manager. If that’s undesirable, omit `--with-deps` and ensure required libraries are installed.

## 🔒 Security
- Do not share or commit your `.env`.
- Consider using environment variables or a secure secrets manager in CI environments.

## 📜 License
This project is provided as‑is; add your preferred license if needed.
