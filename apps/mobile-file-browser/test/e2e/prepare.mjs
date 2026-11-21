import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { PasswordStore } = require('../../dist/server/auth/password.js');

const base = path.join(process.cwd(), '.e2e');
const root = path.join(base, '图片');
const data = path.join(base, 'data');

await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await fs.mkdir(root, { recursive: true });
await fs.mkdir(path.join(root, '2026-11-杭州'), { recursive: true });
await fs.mkdir(path.join(root, '截图'), { recursive: true });
await fs.mkdir(path.join(root, '空文件夹'), { recursive: true });
await fs.mkdir(data, { recursive: true });

const colors = [
  { r: 219, g: 87, b: 71 },
  { r: 59, g: 130, b: 220 },
  { r: 83, g: 176, b: 120 },
  { r: 214, g: 168, b: 52 },
  { r: 146, g: 92, b: 200 },
];

for (let index = 0; index < 3; index += 1) {
  await sharp({
    create: { width: 1200, height: 800, channels: 3, background: colors[index] },
  })
    .jpeg()
    .toFile(path.join(root, '2026-11-杭州', `IMG_000${index + 1}.jpg`));
}
await sharp({
  create: { width: 900, height: 1200, channels: 3, background: colors[3] },
})
  .png()
  .toFile(path.join(root, '截图', '截图 01.png'));
await sharp({
  create: { width: 1400, height: 900, channels: 3, background: colors[4] },
})
  .jpeg()
  .toFile(path.join(root, 'IMG_9001.jpg'));
await fs.writeFile(path.join(root, '说明.txt'), '只读浏览演示\n', 'utf8');

const passwordStore = new PasswordStore(data);
await passwordStore.load();
await passwordStore.setPassword('correct horse battery staple');
console.log('E2E fixtures prepared');
