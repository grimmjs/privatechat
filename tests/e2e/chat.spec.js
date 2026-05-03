const { test, expect } = require('@playwright/test');

test.describe('Private Chat E2E', () => {
  test('should load the login page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Private Chat/);
    const loginForm = page.locator('#authForm');
    await expect(loginForm).toBeVisible();
  });

  test('should show validation error on empty login', async ({ page }) => {
    await page.goto('/');
    await page.click('#authSubmitBtn');
    
    // We expect a toast notification for missing fields
    const toast = page.locator('#toast');
    await expect(toast).toBeVisible();
  });

  // Future test: actual user registration, login, adding a friend, and sending a message.
  // This would require a mocked DB or specific test environment variables to isolate the tests.
});
