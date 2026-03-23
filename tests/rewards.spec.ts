import 'dotenv/config';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { test, request, Browser, BrowserContext, Page, APIRequestContext, devices, Locator } from '@playwright/test';

const stealthPlugin = stealth();
// We already manage UA/locale at the browser-context level, and this evasion
// expects a Chrome-like UA that conflicts with the custom Firefox-style UA used here.
stealthPlugin.enabledEvasions.delete('user-agent-override');
chromium.use(stealthPlugin);

const BING_URL = 'https://www.bing.com/';
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0';

type RewardUser = {
    username: string;
    password: string;
    storagePath: string;
};

type SearchOptions = {
    total: number;
    waitMs: number;
    cooldownEvery: number;
    cooldownMs: number;
    reloadBetween?: boolean;
};

type StoredState = {
    cookies?: StoredCookie[];
    origins?: unknown[];
};

type StoredCookie = {
    name?: string;
    domain?: string;
    expires?: number;
};

test('desktop reuses valid storage, then refreshes the same session in mobile view', async () => {
    // Prepare API and word list
    const api: APIRequestContext = await request.newContext({ baseURL: 'https://api.datamuse.com/', timeout: 10000 });
    const words = await api.get(`words?ml=${process.env.KEYWORD_SEARCH}`);
    const words_response = await words.json() as Array<{ word: string }>;
    const words_array: string[] = words_response.map((wordObj) => wordObj.word);

    // Credentials via environment variables
    const users: RewardUser[] = [
        { username: process.env.USER1, password: process.env.PASS1, storagePath: 'storage-user1.json' },
        { username: process.env.USER2, password: process.env.PASS2, storagePath: 'storage-user2.json' },
    ].map((user, idx) => {
        if (!user.username || !user.password) {
            throw new Error(`Missing USER${idx + 1}/PASS${idx + 1} environment variables`);
        }

        return {
            username: user.username,
            password: user.password,
            storagePath: user.storagePath,
        };
    });

    const desktopSearches = getSearchOptions(parseRequiredNumberEnv('DESKTOP_SEARCHES'));
    const mobileSearches = getSearchOptions(parseRequiredNumberEnv('MOBILE_SEARCHES'), true);

    // Run two desktop browsers in parallel, reusing valid storage when possible.
    await Promise.all(users.map(async (u) => {
        const browser: Browser = await launchRewardsBrowser(DESKTOP_USER_AGENT);
        try {
            const storageState = await isStoredStateReusable(u.storagePath) ? u.storagePath : undefined;
            const context: BrowserContext = await browser.newContext({
                locale: 'pt-BR',
                timezoneId: 'America/Sao_Paulo',
                userAgent: DESKTOP_USER_AGENT,
                geolocation: { latitude: -23.5505, longitude: -46.6333 },
                permissions: ['geolocation'],
                ...(storageState ? { storageState } : {}),
            });

            await hardenContext(context);

            const page: Page = await context.newPage();
            await openBingHome(page);

            if (!(await isSignedInSession(page))) {
                await signInDesktop(page, u.username, u.password);
            }

            await runSearches(page, words_array, desktopSearches);
            await context.storageState({ path: u.storagePath });
            await context.close();
        } finally {
            await browser.close();
        }
    }));

    // After desktop finishes, reuse the stored cookies in mobile, log out in the mobile tab,
    // and log back in through the mobile UI so Microsoft issues a mobile session.
    await Promise.all(users.map(async (u) => {
        const browser: Browser = await launchRewardsBrowser(MOBILE_USER_AGENT);
        try {
            const storageState = await isStoredStateReusable(u.storagePath) ? u.storagePath : undefined;
            const context: BrowserContext = await browser.newContext({
                ...devices['iPhone 13'],
                locale: 'pt-BR',
                timezoneId: 'America/Sao_Paulo',
                geolocation: { latitude: -23.5505, longitude: -46.6333 },
                permissions: ['geolocation'],
                userAgent: MOBILE_USER_AGENT,
                ...(storageState ? { storageState } : {}),
            });

            await hardenContext(context);

            const page: Page = await context.newPage();
            await openBingHome(page);
            await refreshMobileSession(page, u);
            await runSearches(page, words_array, mobileSearches);
            await context.close();
        } finally {
            await browser.close();
        }
    }));
});

function getSearchOptions(total: number, reloadBetween = false): SearchOptions {
    return {
        total,
        waitMs: parseRequiredNumberEnv('WAIT_MS'),
        cooldownEvery: parseRequiredNumberEnv('COOLDOWN_EVERY'),
        cooldownMs: parseRequiredNumberEnv('COOLDOWN_MS'),
        reloadBetween,
    };
}

function parseRequiredNumberEnv(name: string): number {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    if (Number.isNaN(parsed)) {
        throw new Error(`Missing or invalid ${name} environment variable`);
    }

    return parsed;
}

function getRandomWords(words: string[], count: number): string[] {
    const selectedWords = new Set<string>();
    
    while (selectedWords.size < count) {
        const randomIndex = Math.floor(Math.random() * words.length);
        selectedWords.add(words[randomIndex]);
    }
    
    return Array.from(selectedWords);
}

async function acceptCookiesIfVisible(page: Page) {
    const accept = page.locator('#bnp_btn_accept');
    if (await accept.isVisible().catch(() => false)) {
        await accept.click().catch(() => {});
    }
}

async function launchRewardsBrowser(userAgent: string): Promise<Browser> {
    return chromium.launch({
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=VizDisplayCompositor',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
            '--disable-ipc-flooding-protection',
            `--user-agent=${userAgent}`,
        ],
    });
}

async function hardenContext(context: BrowserContext) {
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });
    });
}

async function openBingHome(page: Page) {
    await page.goto(BING_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await acceptCookiesIfVisible(page);
}

async function isStoredStateReusable(storagePath: string): Promise<boolean> {
    try {
        const raw = await fs.readFile(storagePath, 'utf8');
        const parsed = JSON.parse(raw) as StoredState;
        if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
            return false;
        }

        const now = Date.now() / 1000;
        return parsed.cookies.some((cookie) => isStoredCookieReusable(cookie, now));
    } catch {
        return false;
    }
}

function isStoredCookieReusable(cookie: StoredCookie, nowInSeconds: number): boolean {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.domain !== 'string') {
        return false;
    }

    if (typeof cookie.expires === 'number' && cookie.expires >= 0 && cookie.expires <= nowInSeconds) {
        return false;
    }

    return true;
}

async function isSignedInSession(page: Page): Promise<boolean> {
    if (page.url().includes('login.live.com')) {
        return false;
    }

    if (await page.locator('#usernameEntry').isVisible().catch(() => false)) {
        return false;
    }

    if (await page.locator('#passwordEntry').isVisible().catch(() => false)) {
        return false;
    }

    const signInIndicators = [
        page.locator('#id_s').first(),
        page.locator('#hb_s').first(),
        page.locator('.hp_sign_in').first(),
        page.getByRole('link', { name: /Entrar|Sign in/i }).first(),
        page.getByRole('button', { name: /Entrar|Sign in/i }).first(),
    ];

    for (const indicator of signInIndicators) {
        if (await indicator.isVisible().catch(() => false)) {
            return false;
        }
    }

    const accountIndicators = [
        page.locator('#id_p').first(),
        page.locator('#hb_p').first(),
        page.locator('#b_signout').first(),
        page.locator('#hb_signout').first(),
    ];

    for (const indicator of accountIndicators) {
        if (await indicator.isVisible().catch(() => false)) {
            return true;
        }
    }

    const desktopAccountName = page.locator('#id_n').first();
    if (await desktopAccountName.isVisible().catch(() => false)) {
        const accountName = ((await desktopAccountName.textContent().catch(() => null)) ?? '').trim();
        if (accountName.length > 0) {
            return true;
        }
    }

    const mobileAccountName = page.locator('#HBSignIn #hb_n').first();
    if ((await mobileAccountName.count().catch(() => 0)) > 0) {
        const accountName = ((await mobileAccountName.textContent().catch(() => null)) ?? '').trim();
        if (accountName.length > 0) {
            return true;
        }
    }

    if ((await page.locator('#fly_id_rwds_b').count().catch(() => 0)) > 0) {
        const rewardsText = ((await page.locator('#fly_id_rwds_b').first().textContent().catch(() => null)) ?? '').trim();
        if (/Rewards/i.test(rewardsText)) {
            return true;
        }
    }

    const cookies = await page.context().cookies([
        BING_URL,
        'https://rewards.bing.com/',
        'https://login.live.com/',
    ]);

    return cookies.some((cookie) => {
        if (typeof cookie.expires === 'number' && cookie.expires >= 0 && cookie.expires * 1000 <= Date.now()) {
            return false;
        }

        return ['_C_Auth', 'MSPAuth', 'MSPProf', 'RPSSecAuth'].includes(cookie.name);
    });
}

async function signInDesktop(page: Page, username: string, password: string) {
    const signInOpened = await clickFirstVisible([
        page.locator('#id_s').first(),
        page.getByRole('link', { name: /Entrar|Sign in/i }).first(),
        page.getByRole('button', { name: /Entrar|Sign in/i }).first(),
    ], 10000);

    if (!signInOpened) {
        throw new Error('Desktop sign-in button not found');
    }

    await finishMicrosoftLogin(page, username, password);
}

async function signInMobile(page: Page, username: string, password: string) {
    if (!(await hasMicrosoftLoginSurface(page, username))) {
        let signInOpened = await openMobileSignInEntry(page);

        if (!signInOpened) {
            await closeMobileHamburgerMenu(page);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await handlePostReload(page);
            signInOpened = await openMobileSignInEntry(page);
        }

        if (!signInOpened) {
            if (await isSignedInSession(page)) {
                throw new Error('Mobile session is still signed in after logout; sign-in entry did not appear');
            }

            throw new Error('Mobile sign-in button not found');
        }
    }

    await finishMicrosoftLogin(page, username, password, true);
    await openBingHome(page);
    await closeMobileHamburgerMenu(page);
}

async function refreshMobileSession(page: Page, user: RewardUser) {
    await ensureMobileLoggedOut(page);
    await signInMobile(page, user.username, user.password);
}

async function clickContinue(page: Page) {
    const continueButton = page.getByRole('button', { name: /Avançar|Next/i }).first();
    if (await continueButton.isVisible({ timeout: 7000 }).catch(() => false)) {
        await continueButton.click();
        return;
    }

    const textContinue = page.getByText('Avançar').first();
    if (await textContinue.isVisible({ timeout: 7000 }).catch(() => false)) {
        await textContinue.click();
        return;
    }

    throw new Error('Continue button not found during login flow');
}

async function hasMicrosoftLoginSurface(page: Page, username: string): Promise<boolean> {
    if (page.url().includes('login.live.com')) {
        return true;
    }

    if (await page.locator('#usernameEntry').isVisible().catch(() => false)) {
        return true;
    }

    if (await page.locator('#passwordEntry').isVisible().catch(() => false)) {
        return true;
    }

    const usernamePattern = new RegExp(escapeRegExp(username), 'i');
    return (
        await page.getByRole('button', { name: usernamePattern }).first().isVisible().catch(() => false) ||
        await page.getByRole('link', { name: usernamePattern }).first().isVisible().catch(() => false) ||
        await page.getByText(usernamePattern).first().isVisible().catch(() => false)
    );
}

async function finishMicrosoftLogin(page: Page, username: string, password: string, preferRememberedAccount = false) {
    const deadline = Date.now() + 45_000;
    let rememberedAccountAttempted = !preferRememberedAccount;

    while (Date.now() < deadline) {
        if (await isSignedInSession(page)) {
            return;
        }

        if (!(await hasMicrosoftLoginSurface(page, username))) {
            await settleAfterLoginAction(page);

            if (await isSignedInSession(page)) {
                return;
            }

            await page.waitForTimeout(500);
            continue;
        }

        if (await clickStaySignedIn(page)) {
            await settleAfterLoginAction(page);
            continue;
        }

        if (await clickSkipForNow(page)) {
            await settleAfterLoginAction(page);
            continue;
        }

        if (!rememberedAccountAttempted && await clickRememberedAccount(page, username)) {
            rememberedAccountAttempted = true;
            await settleAfterLoginAction(page);
            continue;
        }

        rememberedAccountAttempted = true;

        const usernameEntry = page.locator('#usernameEntry');
        if (await usernameEntry.isVisible().catch(() => false)) {
            await usernameEntry.fill(username);
            await clickContinue(page);
            await settleAfterLoginAction(page);
            continue;
        }

        if (await submitPasswordIfRequested(page, password)) {
            await settleAfterLoginAction(page);
            continue;
        }

        await page.waitForTimeout(500);
    }

    throw new Error(`Login did not complete for ${username}`);
}

async function submitPasswordIfRequested(page: Page, password: string): Promise<boolean> {
    const passwordEntry = page.locator('#passwordEntry');
    if (await passwordEntry.isVisible().catch(() => false)) {
        await passwordEntry.fill(password);
        await clickContinue(page);
        return true;
    }

    if (!(await shouldAttemptPasswordReveal(page))) {
        return false;
    }

    if (!(await revealPasswordEntry(page))) {
        return false;
    }

    await passwordEntry.fill(password);
    await clickContinue(page);
    return true;
}

async function shouldAttemptPasswordReveal(page: Page): Promise<boolean> {
    if (!page.url().includes('login.live.com')) {
        return false;
    }

    const passwordOptions = [
        page.getByRole('button', { name: /Outras maneiras de entrar|Other ways to sign in/i }).first(),
        page.locator('span[role="button"]', { hasText: /Outras maneiras de entrar|Other ways to sign in/i }).first(),
        page.getByRole('button', { name: /Use sua senha|Use your password/i }).first(),
        page.locator('span[role="button"]', { hasText: /Use sua senha|Use your password/i }).first(),
    ];

    for (const option of passwordOptions) {
        if (await option.isVisible().catch(() => false)) {
            return true;
        }
    }

    return false;
}

async function revealPasswordEntry(page: Page): Promise<boolean> {
    const passwordEntry = page.locator('#passwordEntry');
    if (await waitUntilVisible(passwordEntry, 5000)) {
        return true;
    }

    const otherWaysByRole = page.getByRole('button', { name: /Outras maneiras de entrar|Other ways to sign in/i }).first();
    const otherWaysBySpan = page.locator('span[role="button"]', { hasText: /Outras maneiras de entrar|Other ways to sign in/i }).first();
    const clickedOtherWays =
        await waitAndClick(otherWaysByRole, 15000) ||
        await waitAndClick(otherWaysBySpan, 15000);

    if (!clickedOtherWays && await waitUntilVisible(passwordEntry, 5000)) {
        return true;
    }

    const usePasswordByRole = page.getByRole('button', { name: /Use sua senha|Use your password/i }).first();
    const usePasswordBySpan = page.locator('span[role="button"]', { hasText: /Use sua senha|Use your password/i }).first();
    await waitAndClick(usePasswordByRole, 10000) || await waitAndClick(usePasswordBySpan, 10000);

    return waitUntilVisible(passwordEntry, 15000);
}

async function waitUntilVisible(locator: Locator, timeout: number): Promise<boolean> {
    try {
        await locator.waitFor({ state: 'visible', timeout });
        return true;
    } catch {
        return false;
    }
}

async function waitAndClick(locator: Locator, timeout: number): Promise<boolean> {
    try {
        await locator.waitFor({ state: 'visible', timeout });
        await locator.click({ timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

async function clickFirstCurrentlyVisible(locators: Locator[]): Promise<boolean> {
    for (const locator of locators) {
        if (await locator.isVisible().catch(() => false)) {
            await locator.click({ timeout: 5000 }).catch(() => {});
            return true;
        }
    }

    return false;
}

async function settleAfterLoginAction(page: Page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
}

async function clickFirstVisible(locators: Locator[], timeout: number): Promise<boolean> {
    for (const locator of locators) {
        if (await waitAndClick(locator, timeout)) {
            return true;
        }
    }

    return false;
}

async function clickRememberedAccount(page: Page, username: string): Promise<boolean> {
    const usernamePattern = new RegExp(escapeRegExp(username), 'i');
    return clickFirstCurrentlyVisible([
        page.getByRole('button', { name: usernamePattern }).first(),
        page.getByRole('link', { name: usernamePattern }).first(),
        page.getByText(usernamePattern).first(),
    ]);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickStaySignedIn(page: Page): Promise<boolean> {
    return clickFirstCurrentlyVisible([
        page.getByRole('button', { name: /^(Sim|Yes)$/i }).first(),
        page.getByRole('link', { name: /^(Sim|Yes)$/i }).first(),
        page.locator('input[type="submit"][value="Sim"], input[type="submit"][value="Yes"]').first(),
        page.getByText(/^(Sim|Yes)$/i).first(),
    ]);
}

async function clickSkipForNow(page: Page): Promise<boolean> {
    return clickFirstCurrentlyVisible([
        page.getByRole('button', { name: /Pular por enquanto|Skip for now/i }).first(),
        page.getByRole('link', { name: /Pular por enquanto|Skip for now/i }).first(),
        page.getByText(/Pular por enquanto|Skip for now/i).first(),
    ]);
}

async function isMobileHamburgerMenuOpen(page: Page): Promise<boolean> {
    const hamburger = page.locator('#mHamburger').first();
    const expanded = await hamburger.getAttribute('aria-expanded').catch(() => null);
    if (expanded === 'true') {
        return true;
    }

    return page.locator('#HBMenu[aria-hidden="false"]').isVisible().catch(() => false);
}

async function openMobileHamburgerMenu(page: Page): Promise<boolean> {
    const hamburger = page.locator('#mHamburger').first();
    if (!(await hamburger.isVisible().catch(() => false))) {
        return false;
    }

    if (await isMobileHamburgerMenuOpen(page)) {
        return true;
    }

    await hamburger.click();
    await page.waitForTimeout(500);
    return isMobileHamburgerMenuOpen(page);
}

async function closeMobileHamburgerMenu(page: Page): Promise<boolean> {
    if (!(await isMobileHamburgerMenuOpen(page))) {
        return true;
    }

    const closed =
        await waitAndClick(page.locator('#HBFlyoutClose').first(), 3000) ||
        await waitAndClick(page.locator('#mHamburger').first(), 3000);

    if (closed) {
        await page.waitForTimeout(500);
    }

    return !(await isMobileHamburgerMenuOpen(page));
}

async function openMobileSignInEntry(page: Page): Promise<boolean> {
    const menuOpened = await openMobileHamburgerMenu(page);
    if (!menuOpened) {
        return false;
    }

    return clickFirstVisible([
        page.locator('#hb_s').first(),
        page.locator('.hp_sign_in').first(),
        page.getByRole('link', { name: /Entrar|Sign in/i }).first(),
        page.getByRole('button', { name: /Entrar|Sign in/i }).first(),
    ], 7000);
}

async function ensureMobileLoggedOut(page: Page) {
    await closeMobileHamburgerMenu(page);

    if (!(await isSignedInSession(page))) {
        return;
    }

    await clearBingSiteData(page);
    await openBingHome(page);
    await closeMobileHamburgerMenu(page);
}

async function clearBingSiteData(page: Page) {
    const context = page.context();
    const cdp = await context.newCDPSession(page);
    const bingOrigins = [
        'https://bing.com',
        'https://www.bing.com',
        'https://rewards.bing.com',
    ];

    await context.clearCookies({ domain: /(^|\.)bing\.com$/i });

    for (const origin of bingOrigins) {
        await cdp.send('Storage.clearDataForOrigin', {
            origin,
            storageTypes: 'all',
        }).catch(() => {});
    }

    await cdp.detach().catch(() => {});

    await page.evaluate(async () => {
        window.localStorage.clear();
        window.sessionStorage.clear();

        if ('caches' in window) {
            const cacheKeys = await caches.keys();
            await Promise.all(cacheKeys.map((key) => caches.delete(key)));
        }

        if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((registration) => registration.unregister()));
        }
    }).catch(() => {});

    await page.reload({ waitUntil: 'domcontentloaded' }).catch(async () => {
        await openBingHome(page);
    });
    await handlePostReload(page);
}

async function handlePostReload(page: Page) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await acceptCookiesIfVisible(page);
}

async function ensureSearchField(page: Page): Promise<Locator> {
    const searchField = page.locator('#sb_form_q');
    await searchField.waitFor({ state: 'visible', timeout: 15000 });
    return searchField;
}

async function runSearches(
    page: Page,
    wordsArray: string[],
    opts: { total: number; waitMs: number; cooldownEvery: number; cooldownMs: number; reloadBetween?: boolean }
) {
    let searchField = await ensureSearchField(page);
    for (let i = 0; i < opts.total; i++) {
        const query = getRandomWords(wordsArray, 3).join(' ');
        await searchField.fill(query);
        await searchField.press('Enter');
        if ((i + 1) % opts.cooldownEvery === 0) {
            await page.waitForTimeout(opts.cooldownMs);
        }
        await page.waitForTimeout(opts.waitMs);
        if (opts.reloadBetween) {
            await page.reload();
            await handlePostReload(page);
            searchField = await ensureSearchField(page);
        }
    }
}
