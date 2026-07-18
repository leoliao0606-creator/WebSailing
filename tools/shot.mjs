// 无头浏览器验证：截图主菜单与游戏画面，收集控制台错误
import { chromium } from 'playwright';

const OUT = process.env.OUT || '/tmp/claude-1000/-home-cliao-Projects-SailingGame/b12de849-59ee-4287-9630-6dfdcdd8e92d/scratchpad';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 500)}`));

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.waitForTimeout(4500);
await page.screenshot({ path: `${OUT}/01-menu.png` });

// 进入自由航行
await page.click('button[data-act="free"]');
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/02-free-start.png` });

// 收帆加速航行几秒
await page.keyboard.down('w');
await page.waitForTimeout(1500);
await page.keyboard.up('w');
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/03-sailing.png` });

// 转向测试
await page.keyboard.down('a');
await page.waitForTimeout(2500);
await page.keyboard.up('a');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/04-turning.png` });

// 舱内镜头
await page.keyboard.press('c');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/05-onboard.png` });
await page.keyboard.press('c'); // drone
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/06-drone.png` });

// 读取游戏状态
const state = await page.evaluate(() => {
  return window.__game ? 'has-game' : 'no-hook';
});

console.log('STATE:', state);
console.log('ERRORS:', errors.length ? '\n' + errors.slice(0, 20).join('\n') : 'none');
await browser.close();
