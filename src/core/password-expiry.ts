import type { Page } from 'playwright';
import { BROWSER_LOGIN_TIMEOUT, SELECTORS, URLS } from './config';

export function isPasswordExpiryNoticeUrl(url: string): boolean {
  return url.includes(URLS.PASSWORD_EXPIRY_NOTICE);
}

export async function deferPasswordChangeIfRequired(page: Page): Promise<boolean> {
  if (!isPasswordExpiryNoticeUrl(page.url())) {
    return false;
  }

  console.log('[Browser] Password change notice detected; choosing "Change later"');

  try {
    await Promise.all([
      page.waitForURL(url => !isPasswordExpiryNoticeUrl(url.toString()), {
        timeout: BROWSER_LOGIN_TIMEOUT
      }),
      page.locator(SELECTORS.PASSWORD_EXPIRY_DEFER_BUTTON).click({
        timeout: BROWSER_LOGIN_TIMEOUT
      })
    ]);
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `Login failed: Could not defer the password change notice. ` +
        `Please change the password manually on dhlottery.co.kr${cause}`
    );
  }

  console.log('[Browser] Password change deferred successfully');
  return true;
}
