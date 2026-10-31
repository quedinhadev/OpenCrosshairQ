// Assert-based self-check for geometry (no frameworks).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../src/shared/geometry.js');
import assert from 'node:assert/strict';

// Four arms, perpendicular, correct midpoint distance.
const model = G.defaultModel();
const arms = G.computeArms(model);
assert.equal(arms.length, 4);
assert.equal(arms[0].cx, model.gap + model.armLen / 2);
assert.equal(arms[0].cy, 0);
assert.ok(Math.abs(arms[1].cx) < 1e-9, 'right arm has no x offset');
assert.equal(arms[1].cy, model.gap + model.armLen / 2);
// Angle 90deg: sin/cos precision
assert.ok(Math.abs(arms[3].cy - -(model.gap + model.armLen / 2)) < 1e-9, 'bottom arm points down at 270°');

// Scale applied uniformly.
const spec = G.buildSpec(model, 2);
assert.equal(spec.arms[0].w, model.armLen * 2);
assert.equal(spec.dot.r, model.dot.size);

// Dot disabled → null; square shape maps to rect.
assert.equal(G.buildSpec({ ...model, dot: { ...model.dot, enabled: false } }, 1).dot, null);
assert.equal(G.buildSpec({ ...model, dot: { ...model.dot, shape: 'square' } }, 1).dot.shape, 'rect');
for (const disabled of [{ armLen: 0 }, { armThick: 0 }]) {
  assert.deepEqual(G.computeArms({ ...model, ...disabled }), []);
  assert.deepEqual(G.buildSpec({ ...model, ...disabled }, 1).arms, []);
}

// Physical pixel snapping.
assert.equal(G.snapToPhysical(10.4, 1), 10);
assert.equal(G.snapToPhysical(10.4, 2), 10.5);
assert.equal(G.snapToPhysical(10.75, 2), 11); // 21.5 physical rounds half-up to 22 → 11 css

// Rotation rotates arm direction.
const rotated = G.computeArms({ ...model, rotation: 45 });
assert.ok(Math.abs(rotated[0].cy - rotated[0].cx) < 1e-9, '45° arm is diagonal');

console.log('PASS: geometry self-check');
