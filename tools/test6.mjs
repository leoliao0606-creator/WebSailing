// 第六轮：幽灵船（录制->保存->回放）+ 船间风影 的端到端回归。
// 依赖 vite preview (4173)。headless 下游戏时间约为真实时间 40%，等待需放宽。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT || '/tmp/windchaser-test6';
mkdirSync(OUT, { recursive: true });
const URL = 'http://localhost:4173';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.addInitScript(() => {
  localStorage.setItem('windchaser.settings', JSON.stringify({ countdown: 30, windKn: 12, ghost: true, aiCount: 2 }));
  // 清空历史成绩，保证本场必定刷新最佳并写入幽灵轨迹
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('windchaser.best') || k.startsWith('windchaser.ghost')) localStorage.removeItem(k);
  }
});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? '✓' : '✗'}] ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
};

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
}, [dxUp, dxRight, headingUpDeg]);

const status = () => page.evaluate(() => {
  const g = window.__game;
  const e = g.race.entries.get(g.player);
  return { state: g.race.state, leg: e.leg, finished: e.finished, t: g.race.t.toFixed(1) };
});

// ---------- 第 1 场计时赛：跑完全程，产生幽灵轨迹 ----------
console.log('== 第 1 场计时赛（录制幽灵） ==');
await page.click('button[data-act="trial"]');
await page.waitForTimeout(1000);
check('首场无幽灵（无历史最佳）', await page.evaluate(() => !window.__game.ghost));

await tp(-25, 0, 30);
for (let i = 0; i < 50; i++) {
  if ((await status()).state === 'racing') break;
  await page.waitForTimeout(2000);
}
check('起航枪响', (await status()).state === 'racing');
await tp(-12, 0, 20); await page.waitForTimeout(1500);
await tp(368, 4, 45); await page.waitForTimeout(2000);
await tp(-52, 4, 170); await page.waitForTimeout(2000);
await tp(368, -4, 45); await page.waitForTimeout(2000);
await tp(-52, -4, 170); await page.waitForTimeout(2000);
await tp(10, 0, 20); await page.waitForTimeout(2500);
const fin = await status();
check('完赛', fin.finished, `t=${fin.t}s leg=${fin.leg}`);
const saved = await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('windchaser.ghost.12.0') || 'null');
  return d ? { n: d.s.length, t: d.t } : null;
});
check('幽灵轨迹已保存', !!saved && saved.n > 10, saved ? `${saved.n} 帧, ${saved.t.toFixed(1)}s` : 'null');

// ---------- 第 2 场：幽灵应加载并回放 ----------
console.log('== 第 2 场计时赛（回放幽灵） ==');
await page.waitForTimeout(2500); // 等结算面板
await page.click('button[data-act="again"]');
await page.waitForTimeout(1200);
check('幽灵已加载', await page.evaluate(() => !!window.__game.ghost));
check('倒计时阶段幽灵隐藏', await page.evaluate(() => !window.__game.ghost.visual.group.visible));

await tp(-25, 5, 30);
for (let i = 0; i < 50; i++) {
  if ((await status()).state === 'racing') break;
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(2500);
const g2 = await page.evaluate(() => {
  const g = window.__game;
  const gh = g.ghost;
  // 期望位置：录制轨迹在当前 race.t 的最近样本（赛道坐标 -> 世界坐标）
  const data = JSON.parse(localStorage.getItem('windchaser.ghost.12.0'));
  const t = g.race.t;
  let s = data.s[0];
  for (const row of data.s) { if (row[0] <= t) s = row; else break; }
  const c = g.race.course;
  const up = { x: Math.sin(c.windPsi), z: -Math.cos(c.windPsi) };
  const rt = { x: -up.z, z: up.x };
  const ex = c.lineMid.x + up.x * s[1] + rt.x * s[2];
  const ez = c.lineMid.z + up.z * s[1] + rt.z * s[2];
  return {
    visible: gh.visual.group.visible,
    err: Math.hypot(gh.x - ex, gh.z - ez),
    y: gh.visual.group.position.y,
  };
});
check('起航后幽灵现身回放', g2.visible);
check('幽灵位置与录制轨迹一致', g2.err < 20, `偏差 ${g2.err.toFixed(1)}m`);
await page.screenshot({ path: `${OUT}/60-ghost.png` });

// ---------- 风影：正下风的船 shadowF 应显著小于 1 ----------
console.log('== 船间风影 ==');
await page.evaluate(() => window.__game.startRace(2));
await page.waitForTimeout(1500);
const shadow = await page.evaluate(async () => {
  const g = window.__game;
  const ai = g.boats.find((b) => !b.isPlayer);
  const w = g.wind.currentFromPsi();
  const p = g.player.phys;
  // 传送到 AI 正下风 8m
  p.x = ai.phys.x - Math.sin(w) * 8;
  p.z = ai.phys.z + Math.cos(w) * 8;
  p.u = 0; p.v = 0;
  await new Promise((r) => setTimeout(r, 400));
  const inShadow = g.player.shadowF;
  // 再传送到 AI 正上风 30m（干净风）
  p.x = ai.phys.x + Math.sin(w) * 30;
  p.z = ai.phys.z - Math.cos(w) * 30;
  await new Promise((r) => setTimeout(r, 400));
  return { inShadow, clear: g.player.shadowF, aiShadowSeen: g.boats.some((b) => (b.shadowF ?? 1) < 1) };
});
check('正下风 8m 处明显减风', shadow.inShadow < 0.82, `shadowF=${shadow.inShadow.toFixed(2)}`);
check('上风干净风不受影响', shadow.clear > 0.97, `shadowF=${shadow.clear.toFixed(2)}`);
await page.screenshot({ path: `${OUT}/61-shadow.png` });

// ---------- 冲浪诊断量存在 ----------
const surf = await page.evaluate(() => window.__game.player.phys.out.surf);
check('波浪冲浪诊断量在跑', Number.isFinite(surf), `surf=${surf?.toFixed(3)}`);

console.log('ERRORS:', errors.length ? [...new Set(errors)].join('\n') : 'none');
console.log(failures === 0 && errors.length === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
await browser.close();
process.exit(failures === 0 && errors.length === 0 ? 0 : 1);
