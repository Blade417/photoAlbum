import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';
export type { Locator, Page } from '@playwright/test';

// These suites exercise the formed universe; formation.spec.ts covers the opening sphere.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => window.sessionStorage.setItem('stellar-album:formed', '1'));
    await use(page);
  },
});
