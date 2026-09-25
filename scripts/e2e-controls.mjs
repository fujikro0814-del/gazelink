// End-to-end check of the control scheme: keyboard moves the hand (smooth ramps, Shift = slow),
// the mouse is gaze only (left drag does not move the hand), right-drag view manipulation
// freezes the gaze, wheel zooms, and a focus hint is shown when keys cannot reach the canvas.
// usage: node scripts/e2e-controls.mjs <baseUrl> [outDir]
import { chromium } from 'playwright';

const [base, outDir = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const hand = () => page.evaluate(() => [...window.__gazelink.master.handTarget]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const gaze = () => page.evaluate(() => window.__gazelink.gaze?.p ?? null);
const visible = (sel) => page.locator(sel).isVisible();

await page.goto(`${base}/`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForFunction(() => window.__gazelink?.phase === 'joined', null, { timeout: 30000 });
await page.waitForTimeout(1000);
const canvas = page.locator('.scene canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.55;

// 1. no focus: hint shown, keys do nothing
check('focus hint shown before clicking the scene', await visible('.scene-overlay.focus'));
let h0 = await hand();
await page.keyboard.down('KeyW');
await page.waitForTimeout(400);
await page.keyboard.up('KeyW');
await page.waitForTimeout(300);
check('keys do nothing without focus', dist(h0, await hand()) < 1e-9);

// 2. a click focuses the canvas (and does not move the hand)
h0 = await hand();
await page.mouse.click(cx, cy);
await page.waitForTimeout(200);
check('focus hint hidden after clicking the scene', !(await visible('.scene-overlay.focus')));
check('left click does not move the hand', dist(h0, await hand()) < 1e-9);

// 3. W moves the hand horizontally with a smooth ramp up and down
await page.evaluate(() => {
  const s = window.__gazelink;
  window.__rec = [];
  const t0 = performance.now();
  const tick = () => {
    const t = performance.now() - t0;
    window.__rec.push([t, ...s.master.handTarget]);
    if (t < 1600) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(200);
const pressAt = await page.evaluate(() => window.__rec[window.__rec.length - 1][0]);
await page.keyboard.down('KeyW');
await page.waitForTimeout(700);
const releaseAt = await page.evaluate(() => window.__rec[window.__rec.length - 1][0]);
await page.keyboard.up('KeyW');
await page.waitForTimeout(800);
const rec = await page.evaluate(() => window.__rec);
// Speed over a centered 50 ms window: the recorder's frames and the scene's frames are not
// aligned, so frame-to-frame differences alias to 0x / 2x the true speed.
const at = (t) => {
  let i = rec.findIndex((r) => r[0] >= t);
  if (i < 0) i = rec.length - 1;
  return rec[i];
};
const sp = [];
for (const r of rec) {
  const a = at(r[0] - 25);
  const b = at(r[0] + 25);
  const dt = (b[0] - a[0]) / 1000;
  if (dt <= 0.03) continue;
  sp.push([r[0], Math.hypot(b[1] - a[1], b[2] - a[2]) / dt, Math.abs(b[3] - a[3]) / dt]);
}
// top speed: median of the plateau (last 200 ms before release)
const plateau = sp.filter((s) => s[0] > releaseAt - 200 && s[0] < releaseAt - 30).map((s) => s[1]).sort((x, y) => x - y);
const vmax = plateau[Math.floor(plateau.length / 2)];
const after = (t) => sp.filter((s) => s[0] > t);
const t10 = after(pressAt).find((s) => s[1] >= 0.1 * vmax)[0];
const t90 = after(pressAt).find((s) => s[1] >= 0.9 * vmax)[0];
const firstMoving = after(pressAt).find((s) => s[1] > 0.001);
const stop10 = after(releaseAt).find((s) => s[1] <= 0.1 * vmax)?.[0];
const moved = Math.hypot(rec[rec.length - 1][1] - rec[0][1], rec[rec.length - 1][2] - rec[0][2]);
check('W moves the hand horizontally', moved > 0.05 && Math.max(...sp.map((s) => s[2])) < 1e-6, `moved ${(moved * 100).toFixed(1)} cm, top speed ${vmax.toFixed(3)} m/s`);
check('speed ramps up smoothly (no step)', firstMoving[1] < 0.5 * vmax && t90 - t10 >= 70 && t90 - t10 <= 300, `10→90 % in ${(t90 - t10).toFixed(0)} ms, first moving sample at ${((firstMoving[1] / vmax) * 100).toFixed(0)} % of top speed ${vmax.toFixed(3)} m/s`);
check('speed ramps down smoothly after release', stop10 !== undefined && stop10 - releaseAt >= 70 && stop10 - releaseAt <= 350, `to 10 % in ${(stop10 - releaseAt).toFixed(0)} ms`);

// 4. Shift = slow
h0 = await hand();
await page.keyboard.down('Shift');
await page.keyboard.down('KeyW');
await page.waitForTimeout(700);
await page.keyboard.up('KeyW');
await page.keyboard.up('Shift');
await page.waitForTimeout(500);
const slowMoved = dist(h0, await hand());
check('Shift slows the hand down', slowMoved > 0.005 && slowMoved < 0.4 * moved, `${(slowMoved * 100).toFixed(1)} cm vs ${(moved * 100).toFixed(1)} cm`);

// 5. Q moves up, E moves down
h0 = await hand();
await page.keyboard.down('KeyQ');
await page.waitForTimeout(400);
await page.keyboard.up('KeyQ');
await page.waitForTimeout(400);
const hq = await hand();
check('Q moves the hand up', hq[2] - h0[2] > 0.03 && Math.hypot(hq[0] - h0[0], hq[1] - h0[1]) < 1e-6, `dz ${((hq[2] - h0[2]) * 100).toFixed(1)} cm`);

// 6. left drag does not move the hand (first wait until the hand has come to a complete stop)
for (let i = 0; i < 40; i++) {
  const a = await hand();
  await page.waitForTimeout(100);
  if (dist(a, await hand()) === 0) break;
}
h0 = await hand();
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'left' });
for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 20, cy - i * 5);
await page.mouse.up({ button: 'left' });
await page.waitForTimeout(300);
check('left drag does not move the hand', dist(h0, await hand()) < 1e-9);

// 7. right drag: view indicator, gaze frozen, camera moves; release resumes gaze
await page.mouse.move(cx - 150, cy);
await page.waitForTimeout(200);
const gA = await gaze();
const projBefore = await page.evaluate(() => window.__gazeProject([0.5, 0, 0.2]));
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 10; i++) await page.mouse.move(cx - 150 + i * 25, cy + i * 4);
await page.waitForTimeout(150);
const indicator = await visible('.scene-overlay.view');
const gDuring = await gaze();
const projAfter = await page.evaluate(() => window.__gazeProject([0.5, 0, 0.2]));
await page.screenshot({ path: `${outDir}/e2e-controls-viewdrag.png` });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(150);
check('view-manipulation indicator shown during right drag', indicator);
check('gaze point frozen during right drag', gA && gDuring && dist(gA, gDuring) < 1e-9);
check('right drag rotates the view', Math.hypot(projAfter[0] - projBefore[0], projAfter[1] - projBefore[1]) > 0.01);
check('indicator hidden after release', !(await visible('.scene-overlay.view')));
await page.mouse.move(cx + 120, cy + 60);
await page.waitForTimeout(200);
const gB = await gaze();
check('gaze updates again after release', gB && dist(gB, gDuring) > 0.01);

// 8. wheel zooms
const d0 = await page.evaluate(() => window.__gazeViewDistance());
await page.mouse.wheel(0, -400);
await page.waitForTimeout(300);
const d1 = await page.evaluate(() => window.__gazeViewDistance());
check('wheel zooms the view', d1 < d0 - 0.05, `camera distance ${d0.toFixed(2)} → ${d1.toFixed(2)} m`);

// 9. focus lost (click on the panel): hint back, keys ignored
await page.locator('.panel h3').first().click();
await page.waitForTimeout(200);
check('focus hint shown after clicking elsewhere', await visible('.scene-overlay.focus'));
h0 = await hand();
await page.keyboard.down('KeyW');
await page.waitForTimeout(400);
await page.keyboard.up('KeyW');
await page.waitForTimeout(300);
check('keys ignored while unfocused', dist(h0, await hand()) < 1e-9);
await page.screenshot({ path: `${outDir}/e2e-controls-unfocused.png` });

console.log(errors.length ? errors.join('\n') : 'no page errors');
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
