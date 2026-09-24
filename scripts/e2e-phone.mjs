// End-to-end: an operator on a desktop viewport, a spectator on a phone-sized viewport.
// usage: node scripts/e2e-phone.mjs <baseUrl> [outDir]
import { chromium, devices } from 'playwright';

const [base, outDir = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const op = await (await browser.newContext({ viewport: { width: 1400, height: 850 } })).newPage();
await op.goto(`${base}/`);
await op.getByRole('button', { name: '部屋を作る' }).click();
await op.waitForFunction(() => window.__gazelink?.phase === 'joined', null, { timeout: 30000 });
const room = await op.evaluate(() => window.__gazelink.room);
const phone = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
const errors = [];
phone.on('pageerror', (e) => errors.push(e.message));
await phone.goto(`${base}/?room=${room}`);
await phone.waitForFunction(() => window.__gazelink?.phase === 'joined', null, { timeout: 30000 });
await op.evaluate(() => window.__gazelink.setHand([0.5, 0.15, 0.25]));
await op.waitForTimeout(2500);
const r = await phone.evaluate(() => ({ role: window.__gazelink.role, xs: window.__gazelink.state?.xs.map((v) => +v.toFixed(3)) }));
console.log(`room ${room}; phone spectator sees`, JSON.stringify(r));
await phone.screenshot({ path: `${outDir}/e2e-phone.png` });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
