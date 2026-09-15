// 视觉预算集中定义。任何分档都不改变 CPU 风浪采样、航行物理或联机状态。
export const QUALITY_PRESETS = {
  low: { resScale: 0.7, shadowQ: 'off', waterDetail: 'low', cloudDetail: 'low', textureDetail: 'low', modelDetail: 'low', effectsDetail: 'low', effects: false, clouds: false, dynamicRes: true },
  medium: { resScale: 0.85, shadowQ: 'medium', waterDetail: 'medium', cloudDetail: 'medium', textureDetail: 'medium', modelDetail: 'medium', effectsDetail: 'medium', effects: true, clouds: true, dynamicRes: true },
  high: { resScale: 1, shadowQ: 'high', waterDetail: 'high', cloudDetail: 'high', textureDetail: 'high', modelDetail: 'high', effectsDetail: 'high', effects: true, clouds: true, dynamicRes: true },
  // ultra 给带独显的机器：超采样到 1.3×，并关掉动态分辨率，让画面开销吃满而不是自动退让。
  ultra: { resScale: 1.3, shadowQ: 'ultra', waterDetail: 'ultra', cloudDetail: 'ultra', textureDetail: 'ultra', modelDetail: 'ultra', effectsDetail: 'ultra', effects: true, clouds: true, dynamicRes: false },
};

// particles = 粒子池上限，wake = 尾流带的采样行数，rate = 发射率倍数。
export const EFFECT_BUDGETS = {
  low: { particles: 256, wake: 48, rate: 0.40 },
  medium: { particles: 768, wake: 80, rate: 0.70 },
  high: { particles: 2048, wake: 128, rate: 1.15 },
  ultra: { particles: 6144, wake: 208, rate: 2.20 },
};

export const MODEL_BUDGETS = {
  low: { hull: 32, cross: 20, sailRows: 16, sailCols: 12, radial: 10, fittings: false },
  medium: { hull: 56, cross: 32, sailRows: 24, sailCols: 16, radial: 16, fittings: true },
  high: { hull: 88, cross: 48, sailRows: 36, sailCols: 24, radial: 24, fittings: true },
  ultra: { hull: 144, cross: 64, sailRows: 56, sailCols: 36, radial: 32, fittings: true },
};

export const WATER_BUDGETS = {
  low: { rings: 80, sectors: 96, detail: 0 },
  medium: { rings: 128, sectors: 160, detail: 1 },
  high: { rings: 192, sectors: 224, detail: 2 },
  ultra: { rings: 320, sectors: 384, detail: 3 },
};

export const CLOUD_BUDGETS = { low: 2, medium: 3, high: 5, ultra: 6 };
export const TEXTURE_FILTERING = { low: 1, medium: 4, high: 8, ultra: 16 };

export function applyTextureQuality(root, level, maxAnisotropy) {
  const anisotropy = Math.min(TEXTURE_FILTERING[level] ?? 8, maxAnisotropy);
  const seen = new Set();
  root.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const slot of ['map', 'normalMap', 'bumpMap', 'roughnessMap']) {
        const texture = material[slot];
        if (!texture || seen.has(texture)) continue;
        seen.add(texture);
        if (texture.anisotropy !== anisotropy) {
          texture.anisotropy = anisotropy;
          texture.needsUpdate = true;
        }
      }
    }
  });
}
