// End-to-end: with 300 ms one-way delay, move the hand and capture the three overlaid arms
// (real = white, prediction = orange, command ghost = cyan). usage: node scripts/e2e-predict.mjs <baseUrl> [outDir]
import { chromium } from 'playwright';

const [base, outDir = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForFunction(() => window.__gazelink?.phase === 'joined', null, { timeout: 30000 });
await page.getByText('予測アーム（橙）').click();
const n = { delayMs: 300, jitterMs: 0, allowReorder: false, loss: 0, burst: false, burstLength: 4 };
await page.evaluate((x) => window.__gazelink.setNetConfig({ up: x, down: x, seed: 1 }), n);
await page.waitForTimeout(1500);
// sweep the hand sideways and capture mid-motion
const errs = await page.evaluate(async () => {
  const s = window.__gazelink;
  const t0 = performance.now();
  const samples = [];
  await new Promise((resolve) => {
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      s.setHand([0.45, -0.25 + 0.5 * Math.min(1, t / 2.5), 0.35]);
      if (t > 2.2) {
        clearInterval(id);
        resolve();
      }
    }, 16);
  });
  return samples;
});
await page.screenshot({ path: `${outDir}/e2e-predict.png` });
console.log(errors.length ? errors.join('\n') : 'no page errors', errs.length);
await browser.close();
