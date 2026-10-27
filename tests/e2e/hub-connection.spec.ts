import { expect, test } from '@playwright/test'

// Pending (task 0.10): the home screen with "Conectado al hub" was replaced by the operations
// one (pairing, PIN, tables). These tests get rewritten against the new connection indicator
// along with scenario 14, in the final e2e run (docs/ROADMAP.md).
test.skip(true, 'Rewritten with scenario 14 in the final e2e run')

test('the app served by the hub shows it is connected', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Conectado al hub')).toBeVisible()
})

test('the app warns when the hub stops responding and recovers when it comes back', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByText('Conectado al hub')).toBeVisible()

  await page.route('**/api/health', (route) => route.abort('connectionrefused'))
  await expect(page.getByText('Sin conexión con el hub')).toBeVisible()

  await page.unroute('**/api/health')
  await expect(page.getByText('Conectado al hub')).toBeVisible()
})
