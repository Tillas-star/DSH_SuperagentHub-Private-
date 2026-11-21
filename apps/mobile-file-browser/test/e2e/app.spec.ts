import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '手机文件' })).toBeVisible();
  await page.getByLabel('访问密码').fill(PASSWORD);
  await page.getByRole('button', { name: '进入' }).click();
  await expect(page.getByRole('heading', { name: '图片' })).toBeVisible();
}

test('logs in and browses folders and images', async ({ page }) => {
  await login(page);

  const folder = page.getByRole('button', { name: /2026-11-杭州/ });
  await expect(folder).toBeVisible();
  await folder.click();

  const breadcrumb = page.getByRole('navigation', { name: '当前位置' });
  await expect(breadcrumb.getByText('2026-11-杭州')).toBeVisible();

  const firstImage = page.getByRole('button', { name: '查看图片 IMG_0001.jpg' });
  await expect(firstImage).toBeVisible();
  await firstImage.click();

  await expect(page.getByText('IMG_0001.jpg')).toBeVisible();
  await expect(page.getByText('1 / 3')).toBeVisible();
  await expect(page.locator('.viewer-image')).toBeVisible();

  await page.getByRole('button', { name: '下一张' }).click();
  await expect(page.getByText('IMG_0002.jpg')).toBeVisible();
  await expect(page.getByText('2 / 3')).toBeVisible();

  await page.getByRole('button', { name: '返回文件夹' }).click();
  await expect(firstImage).toBeVisible();

  await page.getByRole('navigation', { name: '当前位置' }).getByRole('button', { name: '图片' }).click();
  await expect(folder).toBeVisible();
});

test('shows the empty-folder state', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: /空文件夹/ }).click();
  await expect(page.getByText('这个文件夹是空的')).toBeVisible();
});

test('shows a disconnect banner and recovers', async ({ page }) => {
  await login(page);

  await page.route('**/api/directories**', (route) => route.abort());
  await page.getByRole('button', { name: /截图/ }).click();
  await expect(page.getByRole('heading', { name: '与电脑的连接已断开' })).toBeVisible();

  await page.unroute('**/api/directories**');
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByRole('button', { name: '查看图片 截图 01.png' })).toBeVisible();
});

test('switches the root folder from the sheet', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '切换' }).click();
  await expect(page.getByRole('dialog', { name: '切换根目录' })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();
  await expect(page.getByRole('dialog', { name: '切换根目录' })).toBeHidden();
});
