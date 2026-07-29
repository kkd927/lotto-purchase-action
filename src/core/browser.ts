import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  URLS,
  SELECTORS,
  BROWSER_LOGIN_WAIT,
  BROWSER_LOGIN_TIMEOUT,
  BROWSER_PAGE_POPUP_WAIT,
  LOGIN_ERROR_MESSAGE,
  LOGIN_SUCCESS_TEXT,
  GOTO_TIMEOUT,
  type BrowserConfig
} from './config';
import { deferPasswordChangeIfRequired, isPasswordExpiryNoticeUrl } from './password-expiry';

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private authenticated = false;

  async init(config: BrowserConfig = { headless: true }): Promise<void> {
    if (this.browser) {
      console.log('[Browser] Already initialized');
      return;
    }

    console.log('[Browser] Initializing browser');
    this.browser = await chromium.launch({
      headless: config.headless,
      args: config.args || []
    });

    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    console.log('[Browser] Browser initialized successfully');
  }

  async login(id: string, pwd: string): Promise<void> {
    if (!this.page || !this.context) {
      throw new Error('[Browser] Browser not initialized. Call init() first');
    }

    if (this.authenticated) {
      console.log('[Browser] Already authenticated');
      return;
    }

    console.log('[Browser] Clearing existing cookies');
    await this.context.clearCookies().catch(() => undefined);

    console.log('[Browser] Navigating to login page');
    await this.page.goto(URLS.LOGIN, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT });

    console.log('[Browser] Entering credentials');
    await this.page.locator(SELECTORS.ID_INPUT).fill(id);
    await this.page.locator(SELECTORS.PWD_INPUT).fill(pwd);

    // The login button triggers: AJAX(/login/selectRsaModulus.do) → RSA encrypt → form submit
    // We must wait for the AJAX response to ensure the async login chain completes.
    console.log('[Browser] Clicking login button');
    const rsaResponsePromise = this.page
      .waitForResponse(resp => resp.url().includes('selectRsaModulus.do'), {
        timeout: BROWSER_LOGIN_TIMEOUT
      })
      .then(resp => {
        console.log(`[Browser] RSA modulus response: ${resp.status()}`);
        return resp;
      })
      .catch(err => {
        console.warn('[Browser] RSA modulus request not detected:', err instanceof Error ? err.message : err);
      });

    await this.page.click(SELECTORS.LOGIN_BUTTON);
    await rsaResponsePromise;

    console.log('[Browser] Waiting for login result');
    await this.waitForLoginResult();

    if (await deferPasswordChangeIfRequired(this.page)) {
      console.log('[Browser] Waiting for login result after deferring password change');
      await this.waitForLoginResult();
    }

    // Check success
    if (await this.isLoginSuccessful()) {
      console.log('[Browser] Login successful');
      this.authenticated = true;

      // Close any popup pages
      await this.page.waitForTimeout(BROWSER_PAGE_POPUP_WAIT);
      await this.closeOtherPages();
      return;
    }

    // Check for login error
    const errorPopupWithText = await this.page
      .locator(SELECTORS.LOGIN_ERROR_POPUP)
      .filter({ hasText: LOGIN_ERROR_MESSAGE })
      .count();

    if (errorPopupWithText > 0) {
      throw new Error('Login failed: Incorrect ID or password');
    }

    const diagnostics = await this.getLoginDiagnostics();
    throw new Error(`Login failed: Unknown reason (${diagnostics})`);
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error('[Browser] Browser not initialized');
    }
    return this.page;
  }

  async navigate(url: string): Promise<void> {
    const page = this.getPage();
    console.log(`[Browser] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: GOTO_TIMEOUT });
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private async closeOtherPages(): Promise<void> {
    if (!this.context) return;
    const pages = this.context.pages();
    for (let i = 1; i < pages.length; i++) {
      await pages[i]?.close();
    }
  }

  async close(): Promise<void> {
    // Logout if authenticated
    if (this.authenticated) {
      await this.signOut();
    }

    // Close resources
    if (this.page) {
      await this.page.close().catch(() => undefined);
    }
    if (this.context) {
      await this.context.close().catch(() => undefined);
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
    }

    this.page = null;
    this.context = null;
    this.browser = null;
    this.authenticated = false;

    console.log('[Browser] Browser closed');
  }

  private async signOut(): Promise<void> {
    if (!this.authenticated || !this.page || !this.context) {
      return;
    }

    try {
      console.log('[Browser] Logging out');
      await this.page
        .goto(URLS.LOGOUT, {
          waitUntil: 'load',
          timeout: 10000
        })
        .catch(err => {
          console.warn('[Browser] Logout navigation failed (non-fatal):', err.message);
        });

      await this.context.clearCookies().catch(() => undefined);
      await this.page.waitForTimeout(1000);

      this.authenticated = false;
      console.log('[Browser] Logout successful');
    } catch (error) {
      console.warn('[Browser] Logout failed (non-fatal):', error);
      this.authenticated = false;
    }
  }

  private async waitForLoginResult(): Promise<void> {
    if (!this.page) return;

    const successIndicator = this.page.getByText(LOGIN_SUCCESS_TEXT, { exact: true }).first();
    const errorIndicator = this.page
      .locator(SELECTORS.LOGIN_ERROR_POPUP)
      .filter({ hasText: LOGIN_ERROR_MESSAGE })
      .first();

    try {
      await Promise.race([
        this.page.waitForURL(url => url.toString().includes(URLS.MAIN), {
          timeout: BROWSER_LOGIN_TIMEOUT
        }),
        this.page.waitForURL(url => isPasswordExpiryNoticeUrl(url.toString()), {
          timeout: BROWSER_LOGIN_TIMEOUT
        }),
        successIndicator.waitFor({
          state: 'visible',
          timeout: BROWSER_LOGIN_TIMEOUT
        }),
        errorIndicator.waitFor({
          state: 'visible',
          timeout: BROWSER_LOGIN_TIMEOUT
        })
      ]);
    } catch {
      await this.page.waitForTimeout(BROWSER_LOGIN_WAIT);
    }
  }

  private async isLoginSuccessful(): Promise<boolean> {
    if (!this.page) return false;

    if (this.page.url().includes(URLS.MAIN)) {
      return true;
    }

    const logoutCount = await this.page.getByText(LOGIN_SUCCESS_TEXT, { exact: true }).count();
    return logoutCount > 0;
  }

  private async getLoginDiagnostics(): Promise<string> {
    if (!this.page || !this.context) {
      return 'page not initialized';
    }

    const title = await this.page.title().catch(() => 'unknown');
    const popupTexts = await this.page
      .locator(SELECTORS.LOGIN_ERROR_POPUP)
      .allTextContents()
      .catch(() => []);
    const bodySnippet = await this.page
      .locator('body')
      .innerText()
      .then(text => text.replace(/\s+/g, ' ').slice(0, 300))
      .catch(() => '');
    const cookieNames = await this.context
      .cookies()
      .then(cookies => cookies.map(cookie => cookie.name).join(', '))
      .catch(() => '');

    return [
      `URL: ${this.page.url()}`,
      `title: ${title}`,
      `popupTexts: ${popupTexts.join(' | ') || 'none'}`,
      `bodySnippet: ${bodySnippet || 'none'}`,
      `cookies: ${cookieNames || 'none'}`
    ].join(', ');
  }
}
