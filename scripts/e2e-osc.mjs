// End-to-end: through the real server, press the hand into the wall under 300 ms one-way delay,
// first with "none", then with "TDPA"; report oscillation events and E_gen, save screenshots.
// usage: node scripts/e2e-osc.mjs <baseUrl> [outDir]
import { chromium } from 'playwright';

const [base = 'http://localhost:3456', outDir = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForSelector('.topbar', { timeout: 15000 });
await page.waitForTimeout(1000);

const net = { delayMs: 300, jitterMs: 0, allowReorder: false, loss: 0, burst: false, burstLength: 4 };
await page.evaluate((n) => window.__gazelink.setNetConfig({ up: n, down: n, seed: 1 }), net);

for (const mode of ['none', 'tdpa']) {
  await page.evaluate((m) => {
    const s = window.__gazelink;
    s.setCtrlConfig({ ...s.ctrlcfg, mode: m, gaze: { ...s.ctrlcfg.gaze, enabled: false } });
  }, mode);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__gazelink.reset());
  await page.waitForTimeout(1500);
  // approach the wall through the ring, then press 4 cm into it
  const path = [
    [0.4, -0.16, 0.3],
    [0.5, -0.16, 0.3],
    [0.6, -0.16, 0.3],
    [0.66, -0.16, 0.3],
  ];
  for (const p of path) {
    await page.evaluate((x) => window.__gazelink.setHand(x), p);
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(6000);
  const r = await page.evaluate(() => {
    const s = window.__gazelink;
    const osc = s.events.filter((e) => e.kind === 'oscillation').length;
    const contacts = s.events.filter((e) => e.kind === 'contact_start' && e.data.surface === 'wall').length;
    const eg = s.energySeries.window(0)[1].filter(Number.isFinite);
    return {
      mode: s.ctrlcfg.mode,
      oscillationEvents: osc,
      wallContacts: contacts,
      eGenMax: Math.max(...eg),
      statusOsc: !!(s.state && s.state.status & 2),
      force: s.state ? Math.hypot(...s.state.fe) : null,
    };
  });
  console.log(JSON.stringify(r));
  await page.screenshot({ path: `${outDir}/e2e-osc-${mode}.png` });
  await page.evaluate(() => (window.__gazelink.events.length = 0));
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
