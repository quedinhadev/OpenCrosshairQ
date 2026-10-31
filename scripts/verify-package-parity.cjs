// Verify packaged app.asar contains byte-identical current sources.
const asar = require('@electron/asar');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const unpackedNative = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'native', 'build', 'crosshairq.node');

let checked = 0;
const mismatches = [];

function check(relative) {
  const diskPath = path.join(root, relative);
  const disk = fs.readFileSync(diskPath);
  // Windows asar uses native path.sep; no leading separator.
  const packed = asar.extractFile(archive, relative);
  if (!disk.equals(packed)) mismatches.push(relative);
  checked += 1;
}

function walk(relative) {
  const absolute = path.join(root, relative);
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) walk(child);
    else check(child);
  }
}

walk('src');
walk('assets');

// electron-builder strips build-only metadata from the packaged package.json
// (build config, devDependencies, scripts). Compare runtime-relevant fields.
function checkPackageJson() {
  const diskPath = path.join(root, 'package.json');
  const disk = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
  const packed = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  const runtimeKeys = ['name', 'version', 'description', 'author', 'main', 'license'];
  for (const key of runtimeKeys) {
    if (JSON.stringify(disk[key]) !== JSON.stringify(packed[key])) mismatches.push(`package.json:${key}`);
  }
  checked += 1;
}

checkPackageJson();

const nativeSource = fs.readFileSync(path.join(root, 'native', 'build', 'crosshairq.node'));
const nativePacked = fs.readFileSync(unpackedNative);
const nativeMatches = nativeSource.equals(nativePacked);

console.log(JSON.stringify({
  checked,
  mismatches,
  nativeMatches,
  result: mismatches.length === 0 && nativeMatches ? 'PASS' : 'FAIL',
}, null, 2));

if (mismatches.length || !nativeMatches) process.exit(1);
