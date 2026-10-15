import { test, expect } from '../../playwright';
import { closeAllCollections } from '../utils/page';

const COLLECTION_NAME = 'Schedules Collection';

test.describe('Schedules', () => {
  test.afterEach(async ({ pageWithUserData: page }) => {
    await closeAllCollections(page);
  });

  test('creates a schedule, runs it now and shows the run history', async ({ pageWithUserData: page }) => {
    const card = page.getByTestId('schedule-card').filter({ hasText: 'Ping check' });

    await test.step('Open the Schedules tab from the collection menu', async () => {
      const collection = page.getByTestId('collections').locator('.collection-name').filter({ hasText: COLLECTION_NAME });
      await collection.click();
      await expect(async () => {
        await collection.hover();
        await collection.locator('.collection-actions .icon').click({ timeout: 1000 });
      }).toPass({ timeout: 10000 });
      await page.locator('.dropdown-item').filter({ hasText: 'Schedule Runs' }).click();
      await expect(page.getByTestId('schedules-list')).toContainText('No schedules yet.');
    });

    await test.step('Create a schedule', async () => {
      await page.getByTestId('new-schedule').click();
      const modal = page.getByTestId('edit-schedule-modal');
      await modal.getByTestId('schedule-name-input').fill('Ping check');
      await expect(modal.getByTestId('schedule-next-runs')).toBeVisible();

      await modal.getByTestId('schedule-cron-input').fill('not a cron');
      await expect(modal.getByText('Invalid cron expression')).toBeVisible();
      await modal.getByTestId('schedule-cron-input').fill('*/5 * * * *');
      await expect(modal.getByTestId('schedule-next-runs')).toBeVisible();

      await modal.getByRole('button', { name: 'Create' }).click();
      await expect(card).toContainText('Every 5 minutes');
      await expect(card).toContainText('not run yet');
    });

    await test.step('Run it now and inspect the failed request', async () => {
      await card.getByTestId('schedule-run-now').click();
      await expect(card).toContainText('fail', { timeout: 15000 });

      await card.getByText('Run history (1)').click();
      await card.getByTestId('schedule-runs').locator('.run-row').first().click();
      const requests = card.getByTestId('schedule-run-requests');
      await expect(requests.locator('.run-request')).toHaveCount(2);

      await requests.locator('.run-request').filter({ hasText: 'ping-expect-201' }).click();
      const details = page.getByTestId('schedule-run-details');
      await expect(details.getByTestId('schedule-run-checks')).toContainText('expected 200 to equal 201');

      await details.getByRole('radio', { name: 'Response' }).click();
      await expect(details.getByTestId('schedule-run-response-body')).toContainText('pong');

      await details.getByRole('radio', { name: /Headers/ }).click();
      await expect(details).toContainText('Response headers');
      await page.keyboard.press('Escape');
    });

    await test.step('Delete the schedule', async () => {
      await card.getByTestId('schedule-delete').click();
      await page.getByTestId('delete-schedule-modal').getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByTestId('schedules-list')).toContainText('No schedules yet.');
    });
  });
});
