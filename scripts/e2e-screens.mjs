// End-to-end: run the automated experiment in the browser Worker and capture the experiment and
// explanation screens. usage: node scripts/e2e-screens.mjs <baseUrl> [outDir]
import { chromium } from 'playwright';

const [base, outDir = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto(`${base}/`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForFunction(() => window.__gazelink?.phase === 'joined', null, { timeout: 30000 });

await page.getByRole('button', { name: '自動実験' }).click();
const t0 = Date.now();
await page.getByRole('button', { name: '一括実行' }).click();
await page.waitForSelector('text=倍速', { timeout: 180000 });
console.log(`experiment finished in ${((Date.now() - t0) / 1000).toFixed(1)} s (wall clock)`);
const table = await page.$$eval('.exp-table tbody tr', (rows) =>
  rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent).join(' | ')),
);
console.log(table.join('\n'));
// select "none, gaze OFF, 400 ms"
await page.locator('.exp-table tbody tr').nth(4).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/e2e-experiment.png` });

await page.getByRole('button', { name: '説明' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/e2e-about.png` });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
