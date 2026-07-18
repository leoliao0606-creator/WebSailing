// 第二轮验证：AI 竞速起航流程 / 教学 / 大风翻船与扶正
import { chromium } from 'playwright';

const OUT = process.env.OUT || '/tmp/claude-1000/-home-cliao-Projects-SailingGame/b12de849-59ee-4287-9630-6dfdcdd8e92d/scratchpad';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});

const errors = [];
async function newPage(settings) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${m.type()}] ${m.text().slice(0, 250)}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 400)}`));
  if (settings) await page.addInitScript((s) => localStorage.setItem('windchaser.settings', JSON.stringify(s)), settings);
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  return page;
}

// —— 1) AI 竞速 ——
{
  const page = await newPage({ countdown: 30, windKn: 12, aiCount: 3 });
  await page.click('button[data-act="race"]');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${OUT}/10-race-prestart.png` });
  // 玩家向起航线航行
  await page.keyboard.down('w');
  await page.waitForTimeout(1200);
  await page.keyboard.up('w');
  await page.waitForTimeout(24000); // 等起航
  await page.screenshot({ path: `${OUT}/11-race-started.png` });
  await page.waitForTimeout(20000);
  await page.keyboard.press('c'); // 舱内
  await page.keyboard.press('c'); // 高空看战局
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/12-race-drone.png` });
  await page.close();
}

// —— 2) 教学 ——
{
  const page = await newPage({ windKn: 12 });
  await page.click('button[data-act="tutorial"]');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/13-tutorial.png` });
  // 跳两课看看
  await page.keyboard.press('n');
  await page.waitForTimeout(600);
  await page.keyboard.press('n');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/14-tutorial-step3.png` });
  await page.close();
}

// —— 3) 大风翻船与扶正 ——
{
  const page = await newPage({ windKn: 24, autoHike: false, gustiness: 0.32 });
  await page.click('button[data-act="free"]');
  await page.waitForTimeout(1500);
  // 收死帆逼横倾
  await page.keyboard.down('w');
  await page.waitForTimeout(4000);
  await page.keyboard.up('w');
  // 顶到迎风侧增加侧倾（不压舷）
  await page.keyboard.down('a');
  await page.waitForTimeout(1200);
  await page.keyboard.up('a');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/15-heavy-heel.png` });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/16-capsize.png` });
  // 扶正
  await page.keyboard.down(' ');
  await page.waitForTimeout(4500);
  await page.keyboard.up(' ');
  await page.screenshot({ path: `${OUT}/17-righted.png` });
  await page.close();
}

console.log('ERRORS:', errors.length ? '\n' + [...new Set(errors)].slice(0, 15).join('\n') : 'none');
await browser.close();
