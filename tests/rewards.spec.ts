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
const AUTH_COOKIE_NAMES = new Set(['_C_Auth', 'MSPAuth', 'MSPProf', 'RPSSecAuth']);

type RewardUser = {
    label: string;
    username: string;
    password: string;
    desktopStoragePath: string;
    mobileStoragePath: string;
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

type StorageInspection = {
    reusable: boolean;
    reason: string;
    totalCookies: number;
    reusableCookies: number;
    expiredCookies: number;
    validAuthCookies: string[];
};

type RunLogger = (message: string) => void;

test('desktop and mobile reuse their own valid storage states', async () => {
    const setupLog = createRunLogger('setup');
    setupLog('Starting Bing Rewards Playwright run');

    // Prepare API and word list
    const api: APIRequestContext = await request.newContext({ baseURL: 'https://api.datamuse.com/', timeout: 10000 });
    setupLog(`Fetching keyword pool from Datamuse for "${process.env.KEYWORD_SEARCH}"`);
    const words = await api.get(`words?ml=${process.env.KEYWORD_SEARCH}`);
    const words_response = await words.json() as Array<{ word: string }>;
    const words_array: string[] = words_response.map((wordObj) => wordObj.word);
    setupLog(`Loaded ${words_array.length} candidate words`);

    // Credentials via environment variables
    const users: RewardUser[] = [
        {
            label: 'user1',
            username: process.env.USER1,
            password: process.env.PASS1,
            desktopStoragePath: 'storage-user1.json',
            mobileStoragePath: 'storage-user1-mobile.json',
        },
        {
            label: 'user2',
            username: process.env.USER2,
            password: process.env.PASS2,
            desktopStoragePath: 'storage-user2.json',
            mobileStoragePath: 'storage-user2-mobile.json',
        },
    ].map((user, idx) => {
        if (!user.username || !user.password) {
            throw new Error(`Missing USER${idx + 1}/PASS${idx + 1} environment variables`);
        }

        return {
            label: user.label,
            username: user.username,
            password: user.password,
            desktopStoragePath: user.desktopStoragePath,
            mobileStoragePath: user.mobileStoragePath,
        };
    });

    const desktopSearches = getSearchOptions(parseRequiredNumberEnv('DESKTOP_SEARCHES'));
    const mobileSearches = getSearchOptions(parseRequiredNumberEnv('MOBILE_SEARCHES'), true);
    setupLog(`Desktop searches: total=${desktopSearches.total}, wait=${desktopSearches.waitMs}ms, cooldownEvery=${desktopSearches.cooldownEvery}, cooldown=${desktopSearches.cooldownMs}ms`);
    setupLog(`Mobile searches: total=${mobileSearches.total}, wait=${mobileSearches.waitMs}ms, cooldownEvery=${mobileSearches.cooldownEvery}, cooldown=${mobileSearches.cooldownMs}ms, reloadBetween=${mobileSearches.reloadBetween ? 'yes' : 'no'}`);
    setupLog(`Accounts configured: ${users.map((user) => `${user.label}=${maskUsername(user.username)}`).join(', ')}`);

    // Run two desktop browsers in parallel, reusing valid storage when possible.
    await Promise.all(users.map(async (u) => {
        const log = createRunLogger('desktop', u.label);
        const storageInspection = await inspectStoredState(u.desktopStoragePath);
        const browser: Browser = await launchRewardsBrowser(DESKTOP_USER_AGENT);

        try {
            log(`Starting desktop session for ${maskUsername(u.username)}`);
            log(describeStorageInspection(u.desktopStoragePath, storageInspection));
            log('Launching desktop browser context');

            const storageState = storageInspection.reusable ? u.desktopStoragePath : undefined;
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
            await openBingHome(page, log);

            if (await isSignedInSession(page)) {
                log('Existing desktop session is already signed in');
            } else {
                log('Stored desktop session is not signed in; performing fresh login');
                await signInDesktop(page, u.username, u.password, log);
            }

            await runSearches(page, words_array, desktopSearches, log, 'desktop');
            await context.storageState({ path: u.desktopStoragePath });
            log(`Saved desktop storage state to ${u.desktopStoragePath}`);
            await context.close();
            log('Desktop session completed');
        } catch (error) {
            log(`Desktop session failed: ${formatError(error)}`);
            throw error;
        } finally {
            await browser.close();
        }
    }));
    setupLog('All desktop sessions finished; starting mobile sessions');

    // After desktop finishes, mobile uses its own storage state. If there is no
    // reusable mobile state, start clean and save a new mobile-specific state.
    await Promise.all(users.map(async (u) => {
        const log = createRunLogger('mobile', u.label);
        const storageInspection = await inspectStoredState(u.mobileStoragePath);
        const browser: Browser = await launchRewardsBrowser(MOBILE_USER_AGENT);
        let context: BrowserContext | undefined;

        try {
            log(`Starting mobile session for ${maskUsername(u.username)}`);
            log(describeStorageInspection(u.mobileStoragePath, storageInspection));
            log('Launching mobile browser context');

            const storageState = storageInspection.reusable ? u.mobileStoragePath : undefined;
            context = await createMobileContext(browser, storageState);
            let page: Page = await context.newPage();
            await openBingHome(page, log);

            if (await isSignedInSession(page)) {
                log('Existing mobile session is already signed in');
            } else {
                if (storageState) {
                    log('Stored mobile session is not signed in; restarting with a clean mobile session');
                    await context.close();
                    context = await createMobileContext(browser);
                    page = await context.newPage();
                    await openBingHome(page, log);
                } else {
                    log('No reusable mobile storage found; starting with a clean mobile session');
                }

                await signInMobile(page, u.username, u.password, log);
                await context.storageState({ path: u.mobileStoragePath });
                log(`Saved mobile storage state to ${u.mobileStoragePath} after login`);
            }

            await runSearches(page, words_array, mobileSearches, log, 'mobile');
            await context.storageState({ path: u.mobileStoragePath });
            log(`Saved mobile storage state to ${u.mobileStoragePath}`);
            await context.close();
            context = undefined;
            log('Mobile session completed');
        } catch (error) {
            log(`Mobile session failed: ${formatError(error)}`);
            throw error;
        } finally {
            await context?.close().catch(() => {});
            await browser.close();
        }
    }));
    setupLog('Rewards run finished');
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
    if (words.length < count) {
        throw new Error(`Keyword pool is too small: requested ${count} words, but only ${words.length} are available`);
    }

    const selectedWords = new Set<string>();
    
    while (selectedWords.size < count) {
        const randomIndex = Math.floor(Math.random() * words.length);
        selectedWords.add(words[randomIndex]);
    }
    
    return Array.from(selectedWords);
}

async function acceptCookiesIfVisible(page: Page, log?: RunLogger) {
    const accept = page.locator('#bnp_btn_accept');
    if (await accept.isVisible().catch(() => false)) {
        await accept.click().catch(() => {});
        emitLog(log, 'Accepted the Bing cookie banner');
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

async function createMobileContext(browser: Browser, storageState?: string): Promise<BrowserContext> {
    const context = await browser.newContext({
        ...devices['iPhone 13'],
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        geolocation: { latitude: -23.5505, longitude: -46.6333 },
        permissions: ['geolocation'],
        userAgent: MOBILE_USER_AGENT,
        ...(storageState ? { storageState } : {}),
    });

    await hardenContext(context);
    return context;
}

async function openBingHome(page: Page, log?: RunLogger) {
    emitLog(log, `Opening ${BING_URL}`);
    await page.goto(BING_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await acceptCookiesIfVisible(page, log);
}

async function inspectStoredState(storagePath: string): Promise<StorageInspection> {
    try {
        const raw = await fs.readFile(storagePath, 'utf8');
        const parsed = JSON.parse(raw) as StoredState;
        if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
            return {
                reusable: false,
                reason: 'storage file is missing cookies/origins arrays',
                totalCookies: 0,
                reusableCookies: 0,
                expiredCookies: 0,
                validAuthCookies: [],
            };
        }

        const now = Date.now() / 1000;
        const reusableCookies = parsed.cookies.filter((cookie) => isStoredCookieReusable(cookie, now));
        const validAuthCookies = reusableCookies
            .filter((cookie) => typeof cookie.name === 'string' && AUTH_COOKIE_NAMES.has(cookie.name))
            .map((cookie) => cookie.name as string);

        return {
            reusable: reusableCookies.length > 0,
            reason: reusableCookies.length > 0 ? 'usable cookies found' : 'all stored cookies are expired or malformed',
            totalCookies: parsed.cookies.length,
            reusableCookies: reusableCookies.length,
            expiredCookies: parsed.cookies.length - reusableCookies.length,
            validAuthCookies: Array.from(new Set(validAuthCookies)),
        };
    } catch (error) {
        const message = error instanceof Error && 'code' in error && error.code === 'ENOENT'
            ? 'storage file was not found'
            : formatError(error);

        return {
            reusable: false,
            reason: message,
            totalCookies: 0,
            reusableCookies: 0,
            expiredCookies: 0,
            validAuthCookies: [],
        };
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

        return AUTH_COOKIE_NAMES.has(cookie.name);
    });
}

async function signInDesktop(page: Page, username: string, password: string, log?: RunLogger) {
    emitLog(log, 'Opening desktop sign-in entry');
    const signInOpened = await clickFirstVisible([
        page.locator('#id_s').first(),
        page.getByRole('link', { name: /Entrar|Sign in/i }).first(),
        page.getByRole('button', { name: /Entrar|Sign in/i }).first(),
    ], 10000);

    if (!signInOpened) {
        throw new Error('Desktop sign-in button not found');
    }

    await finishMicrosoftLogin(page, username, password, false, log);
    emitLog(log, 'Desktop sign-in completed');
}

async function signInMobile(page: Page, username: string, password: string, log?: RunLogger) {
    if (!(await hasMicrosoftLoginSurface(page, username))) {
        emitLog(log, 'Mobile login surface not visible yet; opening hamburger sign-in entry');
        let signInOpened = await openMobileSignInEntry(page);

        if (!signInOpened) {
            emitLog(log, 'Mobile sign-in entry did not appear on first attempt; reloading the page');
            await closeMobileHamburgerMenu(page);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await handlePostReload(page, log);
            signInOpened = await openMobileSignInEntry(page);
        }

        if (!signInOpened) {
            if (await isSignedInSession(page)) {
                throw new Error('Mobile session is still signed in after logout; sign-in entry did not appear');
            }

            throw new Error('Mobile sign-in button not found');
        }
    }

    await finishMicrosoftLogin(page, username, password, true, log);
    emitLog(log, 'Mobile sign-in completed; reopening Bing home');
    await openBingHome(page, log);
    await closeMobileHamburgerMenu(page);
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

async function finishMicrosoftLogin(page: Page, username: string, password: string, preferRememberedAccount = false, log?: RunLogger) {
    const deadline = Date.now() + 45_000;
    let rememberedAccountAttempted = !preferRememberedAccount;

    while (Date.now() < deadline) {
        if (await isSignedInSession(page)) {
            emitLog(log, 'Microsoft account reports as signed in');
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
            emitLog(log, 'Accepted the "Stay signed in" prompt');
            await settleAfterLoginAction(page);
            continue;
        }

        if (await clickSkipForNow(page)) {
            emitLog(log, 'Skipped the optional "Skip for now" prompt');
            await settleAfterLoginAction(page);
            continue;
        }

        if (!rememberedAccountAttempted && await clickRememberedAccount(page, username)) {
            rememberedAccountAttempted = true;
            emitLog(log, 'Selected the remembered Microsoft account');
            await settleAfterLoginAction(page);
            continue;
        }

        rememberedAccountAttempted = true;

        const usernameEntry = page.locator('#usernameEntry');
        if (await usernameEntry.isVisible().catch(() => false)) {
            emitLog(log, 'Entering Microsoft username');
            await usernameEntry.fill(username);
            await clickContinue(page);
            await settleAfterLoginAction(page);
            continue;
        }

        if (await submitPasswordIfRequested(page, password, log)) {
            await settleAfterLoginAction(page);
            continue;
        }

        await page.waitForTimeout(500);
    }

    throw new Error(`Login did not complete for ${username}`);
}

async function submitPasswordIfRequested(page: Page, password: string, log?: RunLogger): Promise<boolean> {
    const passwordEntry = page.locator('#passwordEntry');
    if (await passwordEntry.isVisible().catch(() => false)) {
        emitLog(log, 'Entering Microsoft password');
        await passwordEntry.fill(password);
        await clickContinue(page);
        return true;
    }

    if (!(await shouldAttemptPasswordReveal(page))) {
        return false;
    }

    if (!(await revealPasswordEntry(page, log))) {
        return false;
    }

    emitLog(log, 'Entering Microsoft password after switching login method');
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

async function revealPasswordEntry(page: Page, log?: RunLogger): Promise<boolean> {
    const passwordEntry = page.locator('#passwordEntry');
    if (await waitUntilVisible(passwordEntry, 5000)) {
        return true;
    }

    const otherWaysByRole = page.getByRole('button', { name: /Outras maneiras de entrar|Other ways to sign in/i }).first();
    const otherWaysBySpan = page.locator('span[role="button"]', { hasText: /Outras maneiras de entrar|Other ways to sign in/i }).first();
    const clickedOtherWays =
        await waitAndClick(otherWaysByRole, 15000) ||
        await waitAndClick(otherWaysBySpan, 15000);

    if (clickedOtherWays) {
        emitLog(log, 'Opened the "Other ways to sign in" prompt');
    }

    if (!clickedOtherWays && await waitUntilVisible(passwordEntry, 5000)) {
        return true;
    }

    const usePasswordByRole = page.getByRole('button', { name: /Use sua senha|Use your password/i }).first();
    const usePasswordBySpan = page.locator('span[role="button"]', { hasText: /Use sua senha|Use your password/i }).first();
    const clickedUsePassword =
        await waitAndClick(usePasswordByRole, 10000) ||
        await waitAndClick(usePasswordBySpan, 10000);

    if (clickedUsePassword) {
        emitLog(log, 'Switched Microsoft login to password entry');
    }

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

async function handlePostReload(page: Page, log?: RunLogger) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await acceptCookiesIfVisible(page, log);
}

async function ensureSearchField(page: Page): Promise<Locator> {
    const searchField = page.locator('#sb_form_q');
    await searchField.waitFor({ state: 'visible', timeout: 15000 });
    return searchField;
}

async function runSearches(
    page: Page,
    wordsArray: string[],
    opts: { total: number; waitMs: number; cooldownEvery: number; cooldownMs: number; reloadBetween?: boolean },
    log?: RunLogger,
    mode = 'search'
) {
    emitLog(log, `Starting ${mode} loop with ${opts.total} searches`);
    let searchField = await ensureSearchField(page);
    for (let i = 0; i < opts.total; i++) {
        const query = getRandomWords(wordsArray, 3).join(' ');
        emitLog(log, `Search ${i + 1}/${opts.total}: "${query}"`);
        await searchField.fill(query);
        await searchField.press('Enter');
        if ((i + 1) % opts.cooldownEvery === 0) {
            emitLog(log, `Cooldown after search ${i + 1}/${opts.total} for ${opts.cooldownMs}ms`);
            await page.waitForTimeout(opts.cooldownMs);
        }
        await page.waitForTimeout(opts.waitMs);
        if (opts.reloadBetween) {
            emitLog(log, `Reloading page before the next ${mode} search`);
            await page.reload();
            await handlePostReload(page, log);
            searchField = await ensureSearchField(page);
        }
    }
    emitLog(log, `Finished ${mode} loop`);
}

function createRunLogger(stage: string, userLabel?: string): RunLogger {
    return (message: string) => {
        const timestamp = new Date().toISOString();
        const scope = userLabel ? `${stage}:${userLabel}` : stage;
        process.stdout.write(`[${timestamp}] [${scope}] ${message}\n`);
    };
}

function emitLog(log: RunLogger | undefined, message: string) {
    log?.(message);
}

function describeStorageInspection(storagePath: string, inspection: StorageInspection): string {
    const authCookieSummary = inspection.validAuthCookies.length > 0
        ? `valid auth cookies: ${inspection.validAuthCookies.join(', ')}`
        : 'valid auth cookies: none detected';

    const reuseSummary = inspection.reusable ? 'will reuse stored cookies' : 'will start without stored cookies';
    return `${reuseSummary} from ${storagePath}; ${inspection.reason}; total cookies=${inspection.totalCookies}, reusable=${inspection.reusableCookies}, expiredOrInvalid=${inspection.expiredCookies}, ${authCookieSummary}`;
}

function maskUsername(username: string): string {
    const [localPart, domain] = username.split('@');

    if (!domain) {
        return `${username.slice(0, 2)}***`;
    }

    const visibleLocal = localPart.length <= 2 ? localPart[0] ?? '*' : localPart.slice(0, 2);
    return `${visibleLocal}***@${domain}`;
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
