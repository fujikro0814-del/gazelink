// Measures the client physics loop cadence and the channel-generated energy at zero artificial
// delay while the hand moves smoothly. usage: node scripts/e2e-loop.mjs <baseUrl> [gpu|swiftshader]
import { chromium } from 'playwright';

const [base, gl = 'gpu'] = process.argv.slice(2);
const args = gl === 'gpu' ? ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(`${base}/`);
await page.getByRole('button', { name: '部屋を作る' }).click();
await page.waitForFunction(() => window.__gazelink?.phase === 'joined', null, { timeout: 30000 });
const renderer = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const ext = c?.getExtension('WEBGL_debug_renderer_info');
  return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
await page.waitForTimeout(1500);
// smooth circular hand motion for 8 s (as a mouse would do)
await page.evaluate(async () => {
  const s = window.__gazelink;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      s.setHand([0.45 + 0.1 * Math.cos(1.5 * t), 0.12 * Math.sin(1.5 * t), 0.3]);
      if (t > 8) {
        clearInterval(id);
        resolve();
      }
    }, 16);
  });
});
const r = await page.evaluate(() => {
  const s = window.__gazelink;
  s.updateLoopStats();
  const eg = s.energySeries.window(0)[1].filter(Number.isFinite);
  return { loop: s.loopStats, eGenMax: Math.max(...eg), eGenLast: eg[eg.length - 1] };
});
console.log(JSON.stringify({ gl, renderer, ...r }));
await browser.close();
