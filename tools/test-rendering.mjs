#!/usr/bin/env node
// 浏览器验证：画质切换、GPU 着色器编译、存档、天气与固定镜头截图。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { QUALITY_PRESETS, WATER_BUDGETS, CLOUD_BUDGETS, TEXTURE_FILTERING, EFFECT_BUDGETS } from '../src/render/quality.js';

const output = process.env.RENDER_ARTIFACT_DIR || '/tmp/windchaser-rendering';
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
const errors = [];
const report = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => {
    const game = window.__game;
    game.settings.volume = 0;
    game.audio.setVolume(0);
    // 停止自动循环；截图由测试显式渲染，避免不同 GPU 帧率造成时间差。
    game._frame = () => {};
  });

  const freezeScene = async () => {
    await page.evaluate(() => {
      const game = window.__game;
      game.startFree();
      game.wind.setBase(-0.65, 12);
      game.wind.setSeed('rendering-check');
      game.waveField.setConditions(-0.65, 12);
      game.wind.time = game.waveField.time = game.time = 20;
      game.player.place(0, 0, 0.9, 2.5);
      game.player.phys.boom = 0.5;
      game.player.render(20, 1 / 60);
      game.clouds.uniforms.uCloudOffset.value.set(0.3, 1.7);
      game.camera.position.set(7, 3.8, 9);
      game.camera.lookAt(0, 2.2, 0);
      game.followShadow(0, 0);
      game.water.update(game.wind, 7, 9);
      game.hud.visible = false;
      for (const id of ['hud-canvas', 'toast', 'race-banner']) document.getElementById(id).style.display = 'none';
      game.renderer.render(game.scene, game.camera);
    });
  };
  const openSettings = () => page.evaluate(() => window.__game.menu.show('menu-settings'));
  const inspect = () => page.evaluate(() => {
    const g = window.__game;
    let sail;
    g.player.visual.group.traverse(o => { if (o.material?.map) sail = o.material; });
    const gl = g.renderer.getContext();
    return {
      settings: { ...g.settings }, pixelRatio: g.renderer.getPixelRatio(),
      vertices: g.water.mesh.geometry.attributes.position.count,
      triangles: g.water.mesh.geometry.index.count / 3,
      shaderDetail: g.water.material.defines.WATER_DETAIL,
      shadows: g.renderer.shadowMap.enabled, shadowSize: g.sunLight.shadow.mapSize.x,
      cloudOctaves: g.clouds.uniforms.uCloudOctaves.value,
      cloudEnabled: g.clouds.uniforms.uCloudEnabled.value,
      filtering: sail.map.anisotropy, maxFiltering: g.renderer.capabilities.getMaxAnisotropy(),
      waves: Array.from(g.water.wavePack),
      drawCalls: g.renderer.info.render.calls,
      modelDetail: g.player.visual.modelDetail, effectDetail: g.player.effects.detail,
      particleCapacity: g.player.effects.PN, effectsEnabled: g.player.effects.enabled,
      device: g.renderStats.device, powerPreference: gl.getContextAttributes().powerPreference,
      shaderErrors: g.renderer.info.programs.filter(p => p.diagnostics?.runnable === false).length,
      glError: gl.getError(),
    };
  });

  let referenceWaves;
  for (const quality of ['low', 'medium', 'high', 'ultra', 'low', 'high']) {
    await openSettings();
    await page.locator('#s-quality').selectOption(quality);
    assert.equal(await page.locator('#s-water').inputValue(), quality);
    assert.equal(await page.locator('#s-cloud-detail').inputValue(), quality);
    assert.equal(await page.locator('#s-texture').inputValue(), quality);
    await page.locator('#s-back').click();
    await freezeScene();
    const state = await inspect();
    const budget = WATER_BUDGETS[quality];
    for (const [key, value] of Object.entries(QUALITY_PRESETS[quality])) assert.equal(state.settings[key], value, `${quality}.${key}`);
    assert.equal(state.pixelRatio, QUALITY_PRESETS[quality].resScale);
    assert.equal(state.vertices, budget.rings * budget.sectors + 1);
    assert.equal(state.shaderDetail, budget.detail);
    assert.equal(state.cloudOctaves, CLOUD_BUDGETS[quality]);
    assert.equal(state.cloudEnabled, quality === 'low' ? 0 : 1);
    assert.equal(state.shadows, quality !== 'low');
    if (state.shadows) assert.equal(state.shadowSize, { medium: 1024, high: 2048, ultra: 4096 }[quality]);
    assert.equal(state.filtering, Math.min(TEXTURE_FILTERING[quality], state.maxFiltering));
    assert.equal(state.modelDetail, quality);
    assert.equal(state.effectDetail, quality);
    assert.equal(state.particleCapacity, EFFECT_BUDGETS[quality].particles);
    assert.equal(state.effectsEnabled, QUALITY_PRESETS[quality].effects);
    assert.equal(state.powerPreference, 'high-performance');
    assert.equal(state.shaderErrors, 0);
    assert.equal(state.glError, 0);
    referenceWaves ??= state.waves;
    assert.deepEqual(state.waves, referenceWaves, '画质切换不能改变用于物理的波场参数');
    await page.screenshot({ path: path.join(output, `${quality}-golden.png`) });
    const { waves, ...summary } = state;
    report.push({ quality, ...summary });
    console.log(`[rendering] ${quality}: ${state.triangles} water triangles, ${state.drawCalls} draw calls, no shader errors`);
  }

  // 连续航行才能验证发射、贴浪和尾流；不以自动化浏览器的帧率作为硬件基准。
  const sailFor = async (speed, seconds) => page.evaluate(({ speed, seconds }) => {
    const g = window.__game, b = g.player, dt = 1 / 60;
    b.place(0, 0, 0, speed);
    b.phys.boom = 0.8;
    b.phys.crewY = 0.55;
    b.phys.out.planing = speed > 3 ? 0.4 : 0;
    for (let i = 0; i < seconds * 60; i++) {
      g.time += dt;
      g.wind.time = g.waveField.time = g.time;
      b.phys.z -= speed * dt;
      b.render(g.time, dt);
    }
    g.camera.position.set(6, 3.5, b.phys.z + 8);
    g.camera.lookAt(0, 1.6, b.phys.z + 1);
    g.followShadow(0, b.phys.z);
    g.water.update(g.wind, g.camera.position.x, g.camera.position.z);
    g.renderStats.begin();
    g.renderer.render(g.scene, g.camera);
    g.renderStats.end();
    return { active: b.effects.activeParticles, samples: b.effects.samples.length,
      capacity: b.effects.PN, time: b.effects.uniforms.uTime.value };
  }, { speed, seconds });
  for (const quality of ['medium', 'high', 'ultra']) {
    await openSettings();
    await page.locator('#s-quality').selectOption(quality);
    await page.locator('#s-back').click();
    await freezeScene();
    const slow = await sailFor(1.5, 6);
    assert.ok(slow.active >= 8, '正常低速航行也应产生水花');
    assert.ok(slow.samples > 2, '低速尾流应连续记录');
    await page.screenshot({ path: path.join(output, `${quality}-slow-sailing.png`) });
    const fast = await sailFor(4, 8);
    assert.ok(fast.active > slow.active, '高速水花应比低速浓密');
    assert.ok(fast.active <= fast.capacity);
    await page.screenshot({ path: path.join(output, `${quality}-wake.png`) });
    report.push({ quality, slow, fast });
    console.log(`[rendering] ${quality}: ${slow.active} slow / ${fast.active} fast live particles`);
  }
  await page.evaluate(() => {
    const g = window.__game, b = g.player;
    g.camera.position.set(2.5, 1.9, b.phys.z + 2.3);
    g.camera.lookAt(0, 0.85, b.phys.z + 0.25);
    g.renderer.render(g.scene, g.camera);
  });
  await page.screenshot({ path: path.join(output, 'ultra-crew-closeup.png') });
  await page.evaluate(() => {
    const g = window.__game, b = g.player;
    g.camera.position.set(2.8, 0.95, b.phys.z + 1.5);
    g.camera.lookAt(0.55, 0.75, b.phys.z + 0.35);
    g.renderer.render(g.scene, g.camera);
  });
  await page.screenshot({ path: path.join(output, 'ultra-crew-profile.png') });
  for (const side of [1, -1]) {
    await page.evaluate(side => {
      const g = window.__game, b = g.player;
      b.phys.crewY = side * 0.55;
      b.phys.boom = side * 0.8;
      for (let i = 0; i < 90; i++) b.visual.update(b.phys, g.waveField, g.time, 1 / 60);
      g.camera.position.set(-side * 2.5, 1.35, b.phys.z + 1);
      g.camera.lookAt(side * 0.55, 0.8, b.phys.z + 0.35);
      g.renderer.render(g.scene, g.camera);
    }, side);
    await page.screenshot({ path: path.join(output, `crew-${side > 0 ? 'starboard' : 'port'}.png`) });
  }
  const effects = await page.evaluate(() => {
    const g = window.__game, b = g.player, e = b.effects;
    const time = e.time, active = e.activeParticles;
    b.render(g.time, 0);
    const paused = time === e.time && active === e.activeParticles;
    e.setEnabled(false);
    const disabled = e.activeParticles === 0 && !e.wakeMesh.visible && !e.sprayPoints.visible;
    e.setEnabled(true);
    b.phys.x += 500;
    b.render(g.time, 1 / 60);
    return { paused, disabled, reset: e.samples.length === 0 };
  });
  assert.deepEqual(effects, { paused: true, disabled: true, reset: true });
  const stats = await page.evaluate(async () => {
    const g = window.__game;
    for (let i = 0; i < 6; i++) {
      await new Promise(requestAnimationFrame);
      g.renderStats.begin(); g.renderer.render(g.scene, g.camera); g.renderStats.end();
    }
    g.settings.showFps = true;
    document.getElementById('hud-canvas').style.display = '';
    g.hud.draw(g, 0);
    return { device: g.renderStats.device, gpuMs: g.renderStats.gpuMs };
  });
  assert.ok(stats.device.name.length > 0);
  assert.ok(stats.gpuMs === null || Number.isFinite(stats.gpuMs) && stats.gpuMs >= 0);
  report.push({ diagnostics: stats });
  await page.screenshot({ path: path.join(output, 'browser-diagnostics.png') });
  assert.equal((await inspect()).shaderErrors, 0);
  assert.equal((await inspect()).glError, 0);

  for (const weather of ['noon', 'dusk', 'overcast', 'golden']) {
    await openSettings();
    await page.locator('#s-sky').selectOption(weather);
    await page.locator('#s-back').click();
    await freezeScene();
    assert.equal((await inspect()).shaderErrors, 0);
    await page.screenshot({ path: path.join(output, `high-${weather}.png`) });
  }

  // 自定义细项及重载；语言切换后的新控件也要可用。
  await openSettings();
  await page.locator('#s-cloud-detail').selectOption('medium');
  await page.locator('#s-model').selectOption('medium');
  await page.locator('#s-effects-detail').selectOption('ultra');
  assert.equal(await page.locator('#s-quality').inputValue(), 'custom');
  await page.locator('#s-back').click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game);
  const saved = await page.evaluate(() => window.__game.settings);
  assert.equal(saved.quality, 'custom');
  assert.equal(saved.cloudDetail, 'medium');
  assert.equal(saved.modelDetail, 'medium');
  assert.equal(saved.effectsDetail, 'ultra');
  for (const lang of ['en', 'ja', 'zh']) {
    await openSettings();
    await page.locator('#s-lang').selectOption(lang);
    assert.equal(await page.locator('#s-texture option').count(), 4);
    assert.ok((await page.locator('#s-quality-note').textContent()).length > 10);
  }
  await page.setViewportSize({ width: 720, height: 900 });
  await page.locator('#s-quality').selectOption('ultra');
  await page.locator('#s-back').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'settings-720.png') });
  await page.locator('#s-back').click();
  assert.equal(await page.evaluate(() => window.__game.settings.quality), 'ultra');
  assert.deepEqual(errors, [], '浏览器或着色器错误');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ report, errors }, null, 2));
  console.log(`[rendering] PASS: presets, weather, sailing effects, diagnostics, persistence, localization, resize. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
