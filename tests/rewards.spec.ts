import 'dotenv/config';
import { test, request, Browser, BrowserContext, chromium, Page, APIRequestContext, devices } from '@playwright/test';

test('desktop parallel then mobile reusing credentials', async () => {
    // Prepare API and word list
    const api: APIRequestContext = await request.newContext({ baseURL: 'https://api.datamuse.com/', timeout: 10000 });
    const words = await api.get(`words?ml=${process.env.KEYWORD_SEARCH}`);
    const words_response = await words.json();
    const words_array: string[] = words_response.map((wordObj: any) => wordObj.word);

    // Credentials via environment variables
    const users = [
        { username: process.env.USER1, password: process.env.PASS1, storagePath: 'storage-user1.json' },
        { username: process.env.USER2, password: process.env.PASS2, storagePath: 'storage-user2.json' },
    ];

    for (const [idx, u] of users.entries()) {
        if (!u.username || !u.password) {
            throw new Error(`Missing USER${idx + 1}/PASS${idx + 1} environment variables`);
        }
    }

    // Run two desktop browsers in parallel, each logs in and performs searches, then saves storage state
    await Promise.all(users.map(async (u) => {
        const browser: Browser = await chromium.launch();
        const context: BrowserContext = await browser.newContext();
        const page: Page = await context.newPage();
        await page.goto('https://bing.com/');
        await page.waitForLoadState('networkidle');
        await acceptCookiesIfVisible(page);
        await signInDesktop(page, u.username!, u.password!);
        await runSearches(page, words_array, { total: parseInt(process.env.DESKTOP_SEARCHES!), waitMs: parseInt(process.env.WAIT_MS!), cooldownEvery: parseInt(process.env.COOLDOWN_EVERY!), cooldownMs: parseInt(process.env.COOLDOWN_MS!) });
        // Persist auth for reuse in mobile
        await context.storageState({ path: u.storagePath });
        await browser.close();
    }));

    // After both desktop runs finish, start the two mobile browsers (in parallel) with same credentials via storageState
    await Promise.all(users.map(async (u) => {
        const browser: Browser = await chromium.launch();
        const context: BrowserContext = await browser.newContext({
            ...devices['iPhone 13'],
            storageState: u.storagePath,
        });
        const page: Page = await context.newPage();
        await page.goto('https://bing.com/');
        await acceptCookiesIfVisible(page);
        // If not already recognized as signed-in (edge cases), attempt mobile sign-in UI
        await ensureSignedInMobileIfNeeded(page, u.username!);
        await runSearches(page, words_array, { total: parseInt(process.env.MOBILE_SEARCHES!), waitMs: parseInt(process.env.WAIT_MS!), cooldownEvery: parseInt(process.env.COOLDOWN_EVERY!), cooldownMs: parseInt(process.env.COOLDOWN_MS!), reloadBetween: true });
        await browser.close();
    }));
});

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

async function signInDesktop(page: Page, username: string, password: string) {
    // Open sign-in on desktop
    const signInBtn = page.locator('#id_s');
    if (await signInBtn.isVisible().catch(() => false)) {
        await signInBtn.click();
    }
    await page.locator('#usernameEntry').fill(username);
    await page.getByText('Next').click();
    // Password
    await page.locator('#passwordEntry').fill(password);
    await page.getByText('Next').click();
    // Post-login prompts
    if (await page.getByText('Yes').isVisible({ timeout: 10000 })) {
        await page.getByText('Yes').click();
    }
    if (await page.getByText('Skip for now').isVisible({ timeout: 10000 })) {
        await page.getByText('Skip for now').click();
    }
}

async function ensureSignedInMobileIfNeeded(page: Page, username: string) {
    // On mobile, the sign-in is under hamburger menu
    const hamburger = page.locator('#mHamburger');
    const signInLink = page.locator('#hb_s');
    const usernameEntry = page.locator('#usernameEntry');
    if (await usernameEntry.count() > 0 || (await hamburger.isVisible().catch(() => false))) {
        if (await hamburger.isVisible().catch(() => false)) {
            await hamburger.click();
        }
        if (await signInLink.isVisible().catch(() => false)) {
            await signInLink.click();
        }
        if (await usernameEntry.isVisible().catch(() => false)) {
            await usernameEntry.fill(username);
            await page.getByText('Next').click();
            // Assume storageState had password session; otherwise additional steps would be needed.
        }
    }
}

async function runSearches(
    page: Page,
    wordsArray: string[],
    opts: { total: number; waitMs: number; cooldownEvery: number; cooldownMs: number; reloadBetween?: boolean }
) {
    const searchField = page.locator('#sb_form_q');
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
        }
    }
}