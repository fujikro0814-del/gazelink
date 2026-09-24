// End-to-end check of one fallback level: open the app, create a room, and verify which
// transport was chosen and that the remote robot actually follows the hand.
// usage: node scripts/e2e-fallback.mjs <baseUrl> <outDir> <expected: ws|sse|worker> [query]
import { chromium } from 'playwright';

const [base, outDir = '.', expected = 'ws', query = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/${query}`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForFunction(() => window.__gazelink?.phase === 'joined', null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__gazelink.setHand([0.5, -0.15, 0.3]));
await page.waitForTimeout(3000);
const r = await page.evaluate(() => {
  const s = window.__gazelink;
  return {
    transport: s.transportKind,
    serverMode: s.serverMode,
    attempts: s.attempts.map((a) => `${a.kind}:${a.ok ? 'ok' : 'fail'}`).join(' '),
    xs: s.state?.xs.map((v) => +v.toFixed(3)),
    stateRate: s.meters.get('STATE')?.rateHz(performance.timeOrigin + performance.now()),
    rtt: s.clock.rtt,
    banner: document.querySelector('.banner.warn')?.textContent ?? '',
  };
});
console.log(JSON.stringify(r));
const moved = r.xs && Math.abs(r.xs[0] - 0.5) < 0.02 && Math.abs(r.xs[1] + 0.15) < 0.02;
const ok = r.transport === expected && moved;
console.log(ok ? `PASS: ${expected} works and the robot follows the hand` : `FAIL: expected ${expected}`);
await page.screenshot({ path: `${outDir}/e2e-fallback-${expected}.png` });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
process.exit(ok ? 0 : 1);
