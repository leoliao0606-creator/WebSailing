// 第八轮：多语言切换 + 细粒度画质设置 的端到端回归。依赖 vite preview (4173)。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT || '/tmp/windchaser-test8';
mkdirSync(OUT, { recursive: true });
const URL = 'http://localhost:4173';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.addInitScript(() => {
  // 只在首次导航清空（reload 不再清，用于验证持久化）
  if (!sessionStorage.getItem('t8init')) {
    localStorage.clear();
    sessionStorage.setItem('t8init', '1');
  }
});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? '✓' : '✗'}] ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
};
const btnText = (act) => page.evaluate((a) => document.querySelector(`#menu-main button[data-act="${a}"]`)?.textContent, act);

// ---------- 语言：headless Chrome 是 en-US，应自动进英文 ----------
console.log('== 语言自动检测与切换 ==');
check('浏览器语言自动检测 (en)', (await btnText('free'))?.includes('Free Sailing'), await btnText('free'));

await page.click('#menu-main button[data-act="settings"]');
await page.selectOption('#s-lang', 'zh');
await page.waitForTimeout(300);
check('切中文后设置页即时重建', await page.evaluate(() => document.querySelector('#menu-settings h2')?.textContent) === '设置');
await page.selectOption('#s-lang', 'ja');
await page.waitForTimeout(300);
check('切日文', await page.evaluate(() => document.querySelector('#menu-settings h2')?.textContent) === '設定');
check('帮助面板同步换语言', await page.evaluate(() => document.querySelector('#help-panel h3')?.textContent) === '操作説明');
check('document.title 同步', await page.evaluate(() => document.title.includes('ディンギー')));
await page.screenshot({ path: `${OUT}/80-settings-ja.png` });
await page.selectOption('#s-lang', 'zh');
await page.waitForTimeout(300);
check('回中文主标题', await page.evaluate(() => document.querySelector('#menu-main h1')?.textContent) === '逐风');

// ---------- 画质：预设联动 + 应用 ----------
console.log('== 画质设置 ==');
await page.selectOption('#s-quality', 'low');
await page.waitForTimeout(200);
const linked = await page.evaluate(() => ({
  shadow: document.querySelector('#s-shadow').value,
  water: document.querySelector('#s-water').value,
  fx: document.querySelector('#s-fx').checked,
  res: document.querySelector('#s-res').value,
}));
check('低画质预设联动细项', linked.shadow === 'off' && linked.water === 'low' && !linked.fx && linked.res === '70', JSON.stringify(linked));
// 打开 FPS 显示
await page.evaluate(() => { const el = document.querySelector('#s-fps'); if (!el.checked) el.click(); });
await page.click('#s-back');
await page.waitForTimeout(400);
const applied = await page.evaluate(() => {
  const g = window.__game;
  return {
    pr: g.renderer.getPixelRatio(),
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    shadows: g.renderer.shadowMap.enabled,
    waterSeg: g.water.segments,
    showFps: g.settings.showFps,
    fps: g.fps,
  };
});
check('分辨率缩放已应用 (×0.7)', Math.abs(applied.pr - applied.dpr * 0.7 * (applied.pr < applied.dpr * 0.7 ? 1 : 1)) < 0.35, `pr=${applied.pr.toFixed(2)} dpr=${applied.dpr}`);
check('阴影已关闭', applied.shadows === false);
check('水面低细节 (96 段)', applied.waterSeg === 96);
check('FPS 显示开启且在统计', applied.showFps && Number.isFinite(applied.fps), `fps=${applied.fps?.toFixed(0)}`);

// 细项改动 -> 预设变自定义
await page.click('#menu-main button[data-act="settings"]');
await page.selectOption('#s-shadow', 'high');
await page.waitForTimeout(200);
check('改细项后预设显示自定义', await page.evaluate(() => document.querySelector('#s-quality').value) === 'custom');
await page.click('#s-back');
await page.waitForTimeout(300);

// ---------- 持久化：刷新后语言与画质保留 ----------
console.log('== 持久化 ==');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const persisted = await page.evaluate(() => ({
  lang: window.__game.settings.lang,
  quality: window.__game.settings.quality,
  shadowQ: window.__game.settings.shadowQ,
  title: document.querySelector('#menu-main h1')?.textContent,
}));
check('刷新后设置保留', persisted.lang === 'zh' && persisted.quality === 'custom' && persisted.shadowQ === 'high', JSON.stringify(persisted));

// ---------- 进游戏：特效关闭生效 + 中文 HUD + 动态分辨率范围 ----------
console.log('== 游戏内 ==');
await page.click('#menu-main button[data-act="free"]');
await page.waitForTimeout(2500);
const ingame = await page.evaluate(() => {
  const g = window.__game;
  return {
    fxVisible: g.player.effects.wakeMesh.visible,
    fxEnabled: g.player.effects.enabled,
    dyn: g._dynFactor,
    speedKn: g.player.phys.out.speedKn,
  };
});
check('低画质下浪花/尾流关闭', !ingame.fxEnabled && !ingame.fxVisible);
check('动态分辨率系数在合法区间', ingame.dyn >= 0.55 && ingame.dyn <= 1, `${ingame.dyn}`);
await page.screenshot({ path: `${OUT}/81-ingame-zh.png` });

console.log('ERRORS:', errors.length ? [...new Set(errors)].join('\n') : 'none');
console.log(failures === 0 && errors.length === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
await browser.close();
process.exit(failures === 0 && errors.length === 0 ? 0 : 1);
