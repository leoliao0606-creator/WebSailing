// 第五轮：传送加速验证完整比赛流程 + 舱内视角
import { chromium } from 'playwright';
const OUT = process.env.OUT || '/tmp/claude-1000/-home-cliao-Projects-SailingGame/b12de849-59ee-4287-9630-6dfdcdd8e92d/scratchpad';
const URL = 'http://localhost:4173';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.addInitScript((s) => localStorage.setItem('windchaser.settings', JSON.stringify(s)), { countdown: 30, windKn: 12, autoTrim: true });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// 舱内视角检查（船员应隐藏）
await page.click('button[data-act="free"]');
await page.waitForTimeout(3000);
await page.keyboard.press('c');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/40-onboard.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.click('button[data-act="main"]');
await page.waitForTimeout(800);

// 计时赛：传送走完全程
await page.click('button[data-act="trial"]');
await page.waitForTimeout(1000);

const tp = (dxUp, dxRight, headingUpDeg) => page.evaluate(([du, dr, hd]) => {
  const g = window.__game;
  const c = g.race.course;
  const up = { x: Math.sin(c.windPsi), z: -Math.cos(c.windPsi) };
  const rt = { x: -up.z, z: up.x };
  const p = g.player.phys;
  p.x = c.lineMid.x + up.x * du + rt.x * dr;
  p.z = c.lineMid.z + up.z * du + rt.z * dr;
  p.psi = c.windPsi + (hd * Math.PI) / 180;
  p.u = 3; p.v = 0;
  return { leg: g.race.entries.get(g.player).leg, state: g.race.state, t: g.race.t.toFixed(0) };
}, [dxUp, dxRight, headingUpDeg]);

const status = () => page.evaluate(() => {
  const g = window.__game;
  const e = g.race.entries.get(g.player);
  return { state: g.race.state, leg: e.leg, finished: e.finished, ocs: e.ocs, t: g.race.t.toFixed(0) };
});

// 等起航
await tp(-25, 0, 30); // 线下待命
for (let i = 0; i < 40; i++) {
  const s = await status();
  if (s.state === 'racing') break;
  await page.waitForTimeout(2000);
}
console.log('起航后:', JSON.stringify(await status()));
await tp(-12, 0, 20);  await page.waitForTimeout(1500); // 过线
console.log('过线:', JSON.stringify(await status()));
await tp(368, 4, 45); await page.waitForTimeout(2000);  // 到上风标
console.log('绕上风标:', JSON.stringify(await status()));
await tp(-52, 4, 170); await page.waitForTimeout(2000); // 下风标
console.log('绕下风标:', JSON.stringify(await status()));
await tp(368, -4, 45); await page.waitForTimeout(2000);
console.log('第2次上风标:', JSON.stringify(await status()));
await tp(-52, -4, 170); await page.waitForTimeout(2000);
console.log('第2次下风标:', JSON.stringify(await status()));
await page.screenshot({ path: `${OUT}/41-final-leg.png` });
await tp(10, 0, 20); await page.waitForTimeout(2500);   // 跨线冲线
const fin = await status();
console.log('冲线:', JSON.stringify(fin));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/42-results.png` });
console.log('ERRORS:', errors.length ? [...new Set(errors)].join('\n') : 'none');
await browser.close();
