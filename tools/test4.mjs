// 第四轮（preview 静态服务，无 HMR 干扰）：自由巡航尾流 + 完整绕标验证
import { chromium } from 'playwright';
const OUT = process.env.OUT || '/tmp/claude-1000/-home-cliao-Projects-SailingGame/b12de849-59ee-4287-9630-6dfdcdd8e92d/scratchpad';
const URL = 'http://localhost:4173';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const errors = [];
async function newPage(settings) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  if (settings) await page.addInitScript((s) => localStorage.setItem('windchaser.settings', JSON.stringify(s)), settings);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  return page;
}

// 自由巡航：横风自动调帆，验证尾流/浪花/速度
{
  const page = await newPage({ windKn: 16, autoTrim: true, quality: 'medium' });
  await page.click('button[data-act="free"]');
  await page.waitForTimeout(1200);
  console.log('mode:', await page.evaluate(() => window.__game.mode));
  await page.waitForTimeout(25000);
  const d = await page.evaluate(() => {
    const b = window.__game.player.phys;
    return { kn: b.out.speedKn.toFixed(1), plane: b.out.planing.toFixed(2), heel: b.out.heelDeg.toFixed(0), name: window.__game.player.name };
  });
  console.log('巡航状态:', JSON.stringify(d));
  await page.screenshot({ path: `${OUT}/30-cruise.png` });
  // 高空看尾流
  await page.keyboard.press('c'); await page.keyboard.press('c');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/31-cruise-drone.png` });
  await page.close();
}
console.log('ERRORS:', errors.length ? [...new Set(errors)].join('\n') : 'none');
await browser.close();
