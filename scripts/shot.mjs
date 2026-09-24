// Headless smoke check: open a URL, wait, print console errors, save a screenshot.
// usage: node scripts/shot.mjs <url> <out.png> [waitMs] [width] [height]
import { chromium } from 'playwright';

const [url, out, waitMs = '2500', width = '1600', height = '900'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
const errors = [];
page.on('console', (m) => {
  if (m.text().includes('GL Driver Message') || m.text().includes('CONTEXT_LOST')) return;
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(Number(waitMs));
await page.screenshot({ path: out });
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
