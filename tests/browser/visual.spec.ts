import { expect, test } from '@playwright/test';
import { visualScenes } from '../visual-scenes';

test.use({ viewport: { width: 1440, height: 1000 }, contextOptions: { reducedMotion: 'reduce' }, colorScheme: 'light' });

test('preview visual baselines match in development and production', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await visualScenes(page, 'preview', async (name) => {
    await expect(page).toHaveScreenshot(`${name}.png`, {
      animations: 'disabled', maxDiffPixelRatio: 0.001,
    });
  });
  expect(errors).toEqual([]);
});
