// 第三轮：数据驱动验证 AI 竞速全流程 + 自动调帆自由航行的尾流/亮度
import { chromium } from 'playwright';

const OUT = process.env.OUT || '/tmp/claude-1000/-home-cliao-Projects-SailingGame/b12de849-59ee-4287-9630-6dfdcdd8e92d/scratchpad';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const errors = [];

async function newPage(settings) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  if (settings) await page.addInitScript((s) => localStorage.setItem('windchaser.settings', JSON.stringify(s)), settings);
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  return page;
}

const dump = (page) => page.evaluate(() => {
  const g = window.__game;
  return {
    mode: g.mode,
    raceState: g.race?.state,
    raceT: g.race?.t?.toFixed(1),
    boats: g.boats.map((b) => ({
      name: b.name,
      x: b.phys.x.toFixed(0), z: b.phys.z.toFixed(0),
      kn: b.phys.out.speedKn.toFixed(1),
      heel: b.phys.out.heelDeg.toFixed(0),
      capsized: b.phys.capsized,
      leg: g.race?.entries.get(b)?.leg,
      ocs: g.race?.entries.get(b)?.ocs,
    })),
  };
});

// —— AI 竞速全流程 ——
{
  const page = await newPage({ countdown: 30, windKn: 12, aiCount: 3, autoTrim: true });
  await page.click('button[data-act="race"]');
  await page.waitForTimeout(15000);
  console.log('T+15s(倒计时中):', JSON.stringify(await dump(page)));
  // 玩家自动调帆朝线航行（先转向上风）
  await page.keyboard.down('a');
  await page.waitForTimeout(1500);
  await page.keyboard.up('a');
  await page.waitForTimeout(65000);
  console.log('\nT+80s(应已起航):', JSON.stringify(await dump(page)));
  await page.keyboard.press('c');
  await page.keyboard.press('c');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/20-race-fleet.png` });
  await page.waitForTimeout(40000);
  console.log('\nT+120s(第一航段中):', JSON.stringify(await dump(page)));
  await page.screenshot({ path: `${OUT}/21-race-leg1.png` });
  await page.close();
}

// —— 自动调帆巡航（验证尾流与亮度）——
{
  const page = await newPage({ windKn: 14, autoTrim: true });
  await page.click('button[data-act="free"]');
  await page.waitForTimeout(20000);
  const s = await dump(page);
  console.log('\n自由航行:', JSON.stringify(s.boats[0]));
  await page.screenshot({ path: `${OUT}/22-cruise.png` });
  await page.close();
}

console.log('\nERRORS:', errors.length ? [...new Set(errors)].join('\n') : 'none');
await browser.close();
