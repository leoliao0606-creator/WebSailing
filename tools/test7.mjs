// 第七轮：幽灵船渲染视觉探针 —— 注入合成轨迹，把幽灵摆进镜头里拍照。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT || '/tmp/windchaser-test6';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.addInitScript(() => {
  localStorage.setItem('windchaser.settings', JSON.stringify({ countdown: 30, windKn: 12, ghost: true }));
  // 合成幽灵：从起航线下方 20m 处沿赛道轴向上风匀速 1.2m/s，横倾/帆杠给点姿态
  const s = [];
  for (let t = 0; t <= 90; t += 0.2) {
    s.push([+t.toFixed(1), -20 + t * 1.2, 8, 0.1, -0.18, -0.45, 0.5]);
  }
  localStorage.setItem('windchaser.ghost.12.0', JSON.stringify({ v: 1, t: 90, s }));
});
await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.click('button[data-act="trial"]');
await page.waitForTimeout(1000);

const ok = await page.evaluate(() => !!window.__game.ghost);
console.log('幽灵加载:', ok);

// 等起航
for (let i = 0; i < 50; i++) {
  const st = await page.evaluate(() => window.__game.race.state);
  if (st === 'racing') break;
  await page.waitForTimeout(2000);
}
// 把玩家放到幽灵航线的正后方，镜头朝上风 => 幽灵在正前方
await page.evaluate(() => {
  const g = window.__game;
  const c = g.race.course;
  const up = { x: Math.sin(c.windPsi), z: -Math.cos(c.windPsi) };
  const rt = { x: -up.z, z: up.x };
  const t = g.race.t;
  const ghostUp = -20 + t * 1.2;
  const p = g.player.phys;
  p.x = c.lineMid.x + up.x * (ghostUp - 9) + rt.x * 8;
  p.z = c.lineMid.z + up.z * (ghostUp - 9) + rt.z * 8;
  p.psi = c.windPsi;
  p.u = 2;
});
await page.waitForTimeout(1800);
const info = await page.evaluate(() => {
  const g = window.__game;
  return {
    visible: g.ghost.visual.group.visible,
    dist: Math.hypot(g.ghost.x - g.player.phys.x, g.ghost.z - g.player.phys.z).toFixed(1),
    y: g.ghost.visual.group.position.y.toFixed(2),
  };
});
console.log('幽灵状态:', JSON.stringify(info));
await page.screenshot({ path: `${OUT}/62-ghost-visual.png` });
console.log('ERRORS:', errors.length ? [...new Set(errors)].join('\n') : 'none');
await browser.close();
