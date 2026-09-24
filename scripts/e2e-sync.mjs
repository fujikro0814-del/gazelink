// End-to-end check: an operator tab creates a room, a spectator tab joins with the code, the
// operator drags the hand, and both tabs must see the same slave state.
// usage: node scripts/e2e-sync.mjs <baseUrl> [outDir] [transport]
import { chromium } from 'playwright';

const [base = 'http://localhost:3456', outDir = '.', transport = ''] = process.argv.slice(2);
const q = transport ? `?transport=${transport}` : '';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('GL Driver')) errors.push(`[${name}] ${m.text()}`);
  });
};

const op = await ctx.newPage();
watch(op, 'operator');
await op.goto(`${base}/${q}`);
await op.getByRole('button', { name: '部屋を作る' }).click();
await op.waitForSelector('.room b, .banner.warn', { timeout: 15000 });
const room = (await op.locator('.room b').count()) ? await op.locator('.room b').innerText() : '';
const transportLabel = await op.locator('.chip').nth(1).innerText();
console.log(`operator joined room=${room || '(worker)'} via ${transportLabel}`);

let spec = null;
if (room) {
  spec = await ctx.newPage();
  watch(spec, 'spectator');
  await spec.goto(`${base}/?room=${room}${transport ? `&transport=${transport}` : ''}`);
  await spec.waitForSelector('.room b', { timeout: 15000 });
  console.log('spectator joined');
}

// drag the hand toward the wall across the canvas
const canvas = op.locator('.scene canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width * 0.45;
const cy = box.y + box.height * 0.45;
await op.mouse.move(cx, cy);
await op.mouse.down();
for (let i = 0; i <= 30; i++) {
  await op.mouse.move(cx + i * 6, cy - i * 2);
  await op.waitForTimeout(30);
}
await op.mouse.up();
// hover elsewhere: the cursor becomes the gaze point
await op.mouse.move(cx + 300, cy + 60);
await op.waitForTimeout(1500);

const read = (page) =>
  page.evaluate(() => {
    const s = window.__gazelink;
    return s && s.state ? { xs: s.state.xs, seq: s.state.seq, simTime: s.state.simTime, room: s.room } : null;
  });
const a = await read(op);
const b = spec ? await read(spec) : null;
console.log('operator sees  ', JSON.stringify(a));
console.log('spectator sees ', JSON.stringify(b));
if (a && b) {
  const d = Math.hypot(a.xs[0] - b.xs[0], a.xs[1] - b.xs[1], a.xs[2] - b.xs[2]);
  const dt = Math.abs(a.simTime - b.simTime);
  console.log(`difference: |xs|=${(d * 1000).toFixed(2)} mm, simTime=${(dt * 1000).toFixed(0)} ms`);
}
await op.screenshot({ path: `${outDir}/e2e-operator.png` });
if (spec) await spec.screenshot({ path: `${outDir}/e2e-spectator.png` });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
