// QA-only measurements. Ideal center is exact; quantization budget is per axis.
const assert = require('node:assert/strict');
const tolerance = Object.freeze({ idealError: 0, snappingPerAxis: .5, numericalEpsilon: .02, radialGate: false });
function center(dx, dy) {
  const finite = Number.isFinite(dx) && Number.isFinite(dy);
  const idealExact = finite && dx === 0 && dy === 0;
  const pass = finite && Math.abs(dx) <= tolerance.snappingPerAxis + tolerance.numericalEpsilon && Math.abs(dy) <= tolerance.snappingPerAxis + tolerance.numericalEpsilon;
  return { dx, dy, distance: Math.hypot(dx, dy), idealExact, quantizedAcceptable: pass && !idealExact, pass };
}
function raster(image) {
  const size = image.getSize(), { width, height } = size;
  const bytes = image.toBitmap();
  const representation = { getSize: size, bitmapBytes: bytes.length, bytesPerPixel: 4,
    requestedScaleFactor: 1, availableScaleFactors: typeof image.getScaleFactors === 'function' ? image.getScaleFactors() : null,
    units: 'capture bitmap pixels; physical relation must be checked separately' };
  const check = (valid, message) => {
    try { assert.ok(valid, message); } catch (error) { error.representation = representation; throw error; }
  };
  check(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0, 'positive integer bitmap width/height required');
  check(bytes.length === width * height * 4, 'bitmap byte length must equal width*height*4; representation mismatch');
  let left = width, top = height, right = -1, bottom = -1, weight = 0, xSum = 0, ySum = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = bytes[(y * width + x) * 4 + 3];
    if (!alpha) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
    weight += alpha; xSum += (x + .5) * alpha; ySum += (y + .5) * alpha;
  }
  check(Number.isFinite(weight) && weight > 0, 'alpha weight must be positive and finite');
  return { width, height, left, top, right, bottom, weight, cx: xSum / weight, cy: ySum / weight, representation };
}
function captureRelation(pixels, contentBounds, display) {
  const expectedWidth = contentBounds.width * display.scaleFactor, expectedHeight = contentBounds.height * display.scaleFactor;
  return { expectedWidth, expectedHeight, widthError: pixels.width - expectedWidth, heightError: pixels.height - expectedHeight,
    dimensionRoundingTolerance: 1, method: 'capture dimensions versus content bounds DIP * display scaleFactor; not getSize alone',
    physicalDimensionsSupported: Math.abs(pixels.width - expectedWidth) <= 1 && Math.abs(pixels.height - expectedHeight) <= 1 };
}
module.exports = { center, tolerance, raster, captureRelation };
