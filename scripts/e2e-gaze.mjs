// End-to-end: the mouse cursor stands in for the gaze. Hover over the target box (gaze there),
// then drag the hand toward the box: b(t) should drop; hover far away while the hand stays: b rises.
// usage: node scripts/e2e-gaze.mjs <baseUrl> [outDir]
import { chromium } from 'playwright';

const [base = 'http://localhost:3456', outDir = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForSelector('.topbar', { timeout: 15000 });
await page.waitForTimeout(1500);

const box = await page.locator('.scene canvas').boundingBox();
// screen position of a robot-frame point, using the same camera the scene uses
const project = (p) =>
  page.evaluate((pt) => window.__gazeProject?.(pt) ?? null, p);
const target = await project([0.53, 0.21, 0.06]);
const away = await project([0.25, -0.35, 0.0]);
console.log('target on screen', target, 'away', away);

const read = () =>
  page.evaluate(() => {
    const s = window.__gazelink;
    return { b: s.state?.b, attention: s.state?.attention, gaze: s.gaze?.p, hit: s.gaze?.hit };
  });

// 1) look at the target (hover), then move the hand there by keyboard-free drag near the target
await page.mouse.move(box.x + target[0] * box.width, box.y + target[1] * box.height);
await page.waitForTimeout(800);
await page.evaluate(() => window.__gazelink.setHand([0.53, 0.21, 0.12]));
await page.waitForTimeout(4000);
const atTarget = await read();
console.log('looking at the target, hand at the target:', JSON.stringify(atTarget));
await page.screenshot({ path: `${outDir}/e2e-gaze-light.png` });

// 2) look far away while the hand stays at the target
await page.mouse.move(box.x + away[0] * box.width, box.y + away[1] * box.height);
await page.waitForTimeout(4000);
const lookAway = await read();
console.log('looking away, hand at the target:     ', JSON.stringify(lookAway));
await page.screenshot({ path: `${outDir}/e2e-gaze-heavy.png` });

console.log(atTarget.b < 25 && lookAway.b > 40 ? 'PASS: b is light under attention and heavy outside it' : 'CHECK: unexpected b values');
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
