import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderStats } from '../src/render/renderStats.js';

function context({ timing = true, name = 'ANGLE (NVIDIA)', unmasked = true } = {}) {
  const timer = { GPU_DISJOINT_EXT: 1, TIME_ELAPSED_EXT: 2 };
  let nextId = 0;
  const gl = {
    RENDERER: 3, QUERY_RESULT_AVAILABLE: 4, QUERY_RESULT: 5,
    disjoint: false, ready: false, result: 2_000_000,
    open: null, deleted: [],
    getExtension: extension => extension === 'WEBGL_debug_renderer_info'
      ? (unmasked ? { UNMASKED_RENDERER_WEBGL: 6 } : null) : timing ? timer : null,
    getParameter: parameter => parameter === timer.GPU_DISJOINT_EXT ? gl.disjoint : name,
    getQueryParameter: (_q, parameter) => parameter === gl.QUERY_RESULT_AVAILABLE ? gl.ready : gl.result,
    createQuery: () => ++nextId,
    beginQuery: (_target, q) => { assert.equal(gl.open, null, '计时查询不能重叠'); gl.open = q; },
    endQuery: () => { assert.notEqual(gl.open, null); gl.open = null; },
    deleteQuery: q => gl.deleted.push(q),
    isContextLost: () => false,
  };
  return { gl, stats: new RenderStats({ getContext: () => gl }) };
}

test('缺少计时和设备扩展时保留帧率面板，不伪造 GPU 耗时', () => {
  const { gl, stats } = context({ timing: false, unmasked: false, name: 'WebKit WebGL' });
  stats.begin(); stats.end();
  assert.equal(stats.gpuMs, null);
  assert.equal(stats.device.kind, 'unknown');
  assert.equal(gl.open, null);
});

test('识别软件渲染，已完成的 GPU 查询换算为毫秒并释放', () => {
  const { gl, stats } = context({ name: 'ANGLE (SwiftShader Device)' });
  assert.equal(stats.device.kind, 'software');
  stats.begin(); stats.end(); gl.ready = true;
  stats.begin(); stats.end();
  assert.equal(stats.gpuMs, 2);
  assert.deepEqual(gl.deleted, [1]);
});

test('GPU 查询积压时停止发起新查询，时钟失效时丢弃旧结果', () => {
  const { gl, stats } = context();
  for (let i = 0; i < 12; i++) { stats.begin(); stats.end(); }
  assert.equal(stats.pending.length, 4);
  gl.disjoint = true; stats.begin(); stats.end();
  assert.equal(stats.pending.length, 0);
  assert.equal(stats.gpuMs, null);
  assert.equal(gl.deleted.length, 4);
});

test('关闭诊断时释放活动查询及等待中的查询', () => {
  const { gl, stats } = context();
  stats.begin(); stats.end(); stats.begin();
  stats.reset();
  assert.equal(gl.open, null);
  assert.deepEqual(gl.deleted.sort(), [1, 2]);
  assert.equal(stats.pending.length, 0);
});
