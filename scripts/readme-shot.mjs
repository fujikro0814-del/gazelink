// Captures the README screenshot: 300 ms delay, "none", pressing into the wall, gaze on the wall.
// usage: node scripts/readme-shot.mjs <baseUrl> <out.png>
import { chromium } from 'playwright';

const [base, out = 'docs/screenshot.png'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${base}/`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForFunction(() => window.__gazelink?.phase === 'joined', null, { timeout: 30000 });
const n = { delayMs: 300, jitterMs: 10, allowReorder: false, loss: 0.02, burst: false, burstLength: 4 };
await page.evaluate((x) => {
  const s = window.__gazelink;
  s.setNetConfig({ up: x, down: x, seed: 3 });
  s.setCtrlConfig({ ...s.ctrlcfg, gaze: { ...s.ctrlcfg.gaze, enabled: false } });
}, n);
await page.getByText('予測アーム（橙）').click();
await page.waitForTimeout(1200);
// hover the wall so the gaze marker and heat map are visible
const box = await page.locator('.scene canvas').boundingBox();
const wall = await page.evaluate(() => window.__gazeProject([0.62, -0.16, 0.3]));
await page.mouse.move(box.x + wall[0] * box.width, box.y + wall[1] * box.height);
for (const p of [[0.4, -0.16, 0.3], [0.52, -0.16, 0.3], [0.6, -0.16, 0.3], [0.66, -0.16, 0.3]]) {
  await page.evaluate((x) => window.__gazelink.setHand(x), p);
  await page.waitForTimeout(700);
}
await page.waitForTimeout(5200);
await page.screenshot({ path: out });
await browser.close();
