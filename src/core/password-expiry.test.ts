import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { SELECTORS, URLS } from './config';
import { deferPasswordChangeIfRequired, isPasswordExpiryNoticeUrl } from './password-expiry';

interface PageMockOptions {
  clickFails?: boolean;
}

function createPageMock(initialUrl: string, options: PageMockOptions = {}) {
  let currentUrl = initialUrl;
  let clickedSelector = '';
  let clickCount = 0;

  const page = {
    url: () => currentUrl,
    locator: (selector: string) => {
      clickedSelector = selector;
      return {
        click: async () => {
          clickCount += 1;
          if (options.clickFails) {
            throw new Error('button click failed');
          }
          currentUrl = URLS.MAIN;
        }
      };
    },
    waitForURL: async (predicate: (url: URL) => boolean) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (predicate(new URL(currentUrl))) {
          return;
        }
        await Promise.resolve();
      }
      throw new Error(`URL did not change: ${currentUrl}`);
    }
  } as unknown as Page;

  return {
    page,
    getClickedSelector: () => clickedSelector,
    getClickCount: () => clickCount,
    getCurrentUrl: () => currentUrl
  };
}

test('detects the password expiry notice URL', () => {
  assert.equal(isPasswordExpiryNoticeUrl(URLS.PASSWORD_EXPIRY_NOTICE), true);
  assert.equal(isPasswordExpiryNoticeUrl(`${URLS.PASSWORD_EXPIRY_NOTICE}?returnUrl=/main`), true);
  assert.equal(isPasswordExpiryNoticeUrl(URLS.MAIN), false);
});

test('does nothing outside the password expiry notice', async () => {
  const pageMock = createPageMock(URLS.MAIN);

  assert.equal(await deferPasswordChangeIfRequired(pageMock.page), false);
  assert.equal(pageMock.getClickCount(), 0);
});

test('clicks the verified defer button and waits until the notice is left', async () => {
  const pageMock = createPageMock(URLS.PASSWORD_EXPIRY_NOTICE);

  assert.equal(await deferPasswordChangeIfRequired(pageMock.page), true);
  assert.equal(pageMock.getClickedSelector(), SELECTORS.PASSWORD_EXPIRY_DEFER_BUTTON);
  assert.equal(pageMock.getClickedSelector(), '#btnCancel');
  assert.equal(pageMock.getClickCount(), 1);
  assert.equal(pageMock.getCurrentUrl(), URLS.MAIN);
});

test('reports an actionable error when deferring the password change fails', async () => {
  const pageMock = createPageMock(URLS.PASSWORD_EXPIRY_NOTICE, { clickFails: true });

  await assert.rejects(
    () => deferPasswordChangeIfRequired(pageMock.page),
    /Could not defer the password change notice.*change the password manually/
  );
});
