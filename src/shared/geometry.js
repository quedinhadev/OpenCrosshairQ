// Crosshair layout math. Pure functions, shared by main (CJS), the overlay
// renderer (classic script) and tests. Dual export, no build step.
// Mirrors the arms+dot+outline mechanism observed in the original,
// reimplemented from scratch. No original code copied.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CQGeometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Arm rectangles for a 4-arm cross centered at (0,0). */
  function computeArms(model) {
    const { gap, armLen, armThick, rotation = 0 } = model;
    if (armLen <= 0 || armThick <= 0) return [];
    const arms = [];
    for (let i = 0; i < 4; i++) {
      const angle = ((rotation + i * 90) * Math.PI) / 180;
      const mid = gap + armLen / 2;
      arms.push({
        cx: Math.cos(angle) * mid,
        cy: Math.sin(angle) * mid,
        w: armLen,
        h: armThick,
        rot: rotation + i * 90,
      });
    }
    return arms;
  }

  /** Snap a CSS-px coordinate to the physical pixel grid (original DPI mechanism). */
  function snapToPhysical(css, dpr) {
    return Math.round(css * dpr) / dpr;
  }

  /** SVG element spec for a model at a scale factor. */
  function buildSpec(model, scale) {
    const s = (v) => v * scale;
    const spec = {
      arms: computeArms(model).map((a) => ({
        x: s(a.cx - a.w / 2), y: s(a.cy - a.h / 2),
        w: s(a.w), h: s(a.h), rot: a.rot,
      })),
      dot: null,
    };
    if (model.dot && model.dot.enabled && model.dot.size > 0) {
      spec.dot = {
        shape: model.dot.shape === 'square' ? 'rect' : 'circle',
        cx: 0, cy: 0, r: s(model.dot.size / 2),
      };
    }
    return spec;
  }

  function defaultModel() {
    return {
      gap: 4, armLen: 8, armThick: 2, rotation: 0,
      color: '#ffffff', opacity: 1,
      dot: { enabled: true, size: 2, shape: 'circle' },
      outline: { enabled: true, width: 1, color: '#000000' },
    };
  }

  return { computeArms, snapToPhysical, buildSpec, defaultModel };
});
