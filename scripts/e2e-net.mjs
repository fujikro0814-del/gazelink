// End-to-end check of the degrader and the measurements: apply a NETCFG, wait, then compare the
// observed one-way delay / loss / burst statistics with the setting. Saves a screenshot of the
// protocol view. usage: node scripts/e2e-net.mjs <baseUrl> [outDir] [transport]
import { chromium } from 'playwright';

const [base = 'http://localhost:3456', outDir = '.', transport = ''] = process.argv.slice(2);
const q = transport ? `?transport=${transport}` : '';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/${q}`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForSelector('.topbar', { timeout: 15000 });
await page.getByRole('button', { name: 'プロトコル観察' }).click();
await page.waitForTimeout(1000);

const setting = { delayMs: 200, jitterMs: 30, allowReorder: false, loss: 0.1, burst: true, burstLength: 4 };
await page.evaluate((p) => window.__gazelink.setNetConfig({ up: p, down: p, seed: 777 }), setting);
await page.waitForTimeout(9000);

const r = await page.evaluate(() => {
  const s = window.__gazelink;
  const m = s.meters.get('STATE');
  const hist = m.owdHist;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  hist.forEach((c, i) => {
    const x = i * 10 + 5;
    n += c;
    sum += c * x;
    sum2 += c * x * x;
  });
  const mean = sum / n;
  const up = s.stats?.up?.CMD;
  const deg = s.stats?.degrader;
  let runs = 0;
  let lostInRuns = 0;
  deg?.burstHist.forEach((c, k) => {
    runs += c;
    lostInRuns += c * k;
  });
  return {
    transport: s.transportKind,
    down: { n, meanOwd: mean, sdOwd: Math.sqrt(sum2 / n - mean * mean), loss: m.lossRatio, late: m.late },
    up: up ? { n: up.received, loss: up.lost / (up.lost + up.received), jitter: up.jitterMs } : null,
    burst: { runs, meanLen: lostInRuns / runs, dropped: deg?.dropped, passed: deg?.passed },
    clockOffset: s.clock.offset,
    rtt: s.clock.rtt,
  };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: `${outDir}/e2e-protocol.png` });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
