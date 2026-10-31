import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const L = require('../src/shared/layers.js');

// SVG numbers serialize to 1e-6 document units. Allow <= 2e-6 CSS px
// after max tested scale=2, <= 4e-6 physical px at DPR=2; no raster assertion.
const close = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} != ${b}, tol=${tolerance}`);
for (const shape of ['rect', 'triangle', 'chevron']) {
  test(`${shape}: non-cardinal arm axis and outward tip stay radial under one parent transform`, () => {
    for (const count of [1, 3, 4, 5, 8]) for (const angle of [0, 30, -22.5, 90]) {
      const layer = { ...L.newModelLayer(), id: 'radial', armCount: count, armRotation: angle,
        armLength: 9, armThickness: 3, armSpacing: 5, armShape: shape,
        x: 7.5, y: -3.25, rotation: 37, scale: 1.25 };
      const svg = L.renderLayers([layer]);
      if (shape !== 'rect') {
        const points = svg.match(/<polygon points="([^"]+)"/)[1].split(' ').map(pair => pair.split(',').map(Number));
        assert.ok(points.some(([x, y]) => x === 4.5 && y === 0), 'actual polygon tip lies on local +X');
        assert.ok(points.every(([x]) => x <= 4.5), 'no polygon vertex extends beyond outward tip');
      }
      const parent = svg.match(/translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\) scale\(([-\d.]+)\)/).slice(1).map(Number);
      const transform = (x, y) => {
        const [tx, ty, degrees, scale] = parent, radians = degrees * Math.PI / 180;
        return { x: tx + scale * (x * Math.cos(radians) - y * Math.sin(radians)),
          y: ty + scale * (x * Math.sin(radians) + y * Math.cos(radians)) };
      };
      const arms = [...svg.matchAll(/<g transform="translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)">/g)];
      assert.equal(arms.length, count);
      assert.match(svg, /translate\(7.5 3.25\) rotate\(37\) scale\(1.25\)/, 'parent convention unchanged');
      for (const [index, arm] of arms.entries()) {
        const [cx, cy, rotation] = arm.slice(1).map(Number);
        const theta = (angle + index * 360 / count) * Math.PI / 180;
        const r = rotation * Math.PI / 180;
        const axis = { x: Math.cos(r), y: Math.sin(r) };
        const radial = { x: Math.cos(theta), y: -Math.sin(theta) };
        close(cx, radial.x * 9.5, 0.5e-6, 'center x');
        close(cy, radial.y * 9.5, 0.5e-6, 'center y');
        close(axis.x * radial.y - axis.y * radial.x, 0, 1e-8, 'axis cross radial');
        close(axis.x * radial.x + axis.y * radial.y, 1, 1e-8, 'axis points outward, not reversed');
        // Triangle and chevron first +X tip lies at radius gap+length=14.
        for (const scale of [0.5, 1, 1.5, 2]) for (const dpr of [1, 1.25, 1.5, 2]) {
          const tip = transform(cx + axis.x * 4.5, cy + axis.y * 4.5);
          const expected = transform(radial.x * 14, radial.y * 14);
          for (const axis of ['x', 'y']) {
            close(tip[axis] * scale, expected[axis] * scale, 2e-6, 'tip CSS ' + axis);
            close(tip[axis] * scale * dpr, expected[axis] * scale * dpr, 4e-6, 'tip physical ' + axis);
          }
        }
      }
    }
  });
}
