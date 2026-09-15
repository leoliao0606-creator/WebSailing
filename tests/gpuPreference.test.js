import assert from 'node:assert/strict';
import test from 'node:test';
import { gpuStartupPlan } from '../electron/gpuPreference.js';

const linux = { platform: 'linux', nvidiaAvailable: true, env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, argv: [] };
test('Linux NVIDIA 桌面启动设置 PRIME，但不改动显示后端', () => {
  const p = gpuStartupPlan(linux);
  assert.equal(p.env.__NV_PRIME_RENDER_OFFLOAD, '1');
  assert.equal(p.env.__GLX_VENDOR_LIBRARY_NAME, 'nvidia');
  // 强切 XWayland 在 Wayland 会话下会让 GPU 子进程反复崩溃、窗口起不来，
  // 实测（RTX PRO 2000 + Mesa ARL 核显）比留在核显上更慢，所以一个开关都不加。
  assert.deepEqual(p.switches, []);
});
test('无独显、非 Linux 和用户指定系统选择时保持默认', () => {
  for (const patch of [{ nvidiaAvailable: false }, { platform: 'darwin' }, { platform: 'win32' }, { env: { ...linux.env, WINDCHASER_GPU: 'system' } }]) {
    assert.deepEqual(gpuStartupPlan({ ...linux, ...patch }), { env: {}, switches: [] });
  }
});
test('不覆盖显式显示后端，不干扰软件渲染测试', () => {
  assert.deepEqual(gpuStartupPlan({ ...linux, argv: ['--use-angle=swiftshader'] }), { env: {}, switches: [] });
  assert.deepEqual(gpuStartupPlan({ ...linux, env: { ...linux.env, WINDCHASER_SMOKE: '1' } }), { env: {}, switches: [] });
  assert.deepEqual(gpuStartupPlan({ ...linux, argv: ['--ozone-platform=wayland'] }).switches, []);
  assert.deepEqual(gpuStartupPlan({ ...linux, argv: ['--ozone-platform=x11'] }).switches, []);
});
