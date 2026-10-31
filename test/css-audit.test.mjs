import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const uiHtml = read('../src/ui/index.html');
const designerHtml = read('../src/designer/designer.html');
const designerPreload = read('../src/designer/preload.js');

test('UI1: switch input focus-visible rule is present with accent outline', () => {
  assert.match(
    uiHtml,
    /\.switch\s+input:focus-visible\s*\+\s*i\s*\{\s*outline:\s*2px\s+solid\s+var\(--accent\);\s*outline-offset:\s*2px;\s*\}/
  );
});

test('UI6: dead selectors and keyframes are removed from UI styles', () => {
  const deadSelectors = [
    /\.rz-(?:box|canvas|wheel|track|preview|controls|spin-btn|spinning)\b/,
    /@keyframes\s+rz(?:Run|Pulse)\b/,
    /\.sup-(?:tabs|tab|body|card|head|desc|field|input|textarea|send)\b/,
    /\.news-(?:head|grid|card|thumb|body|tag|title|date|summary)\b/,
    /\.shop-(?:banner|grid|card|thumb|badge|body|title|desc|foot|price|buy)\b/,
    /\.cur-(?:layout|actions|action|disclaimer)\b/,
  ];

  for (const regex of deadSelectors) {
    assert.doesNotMatch(uiHtml, regex, `Found dead selector matching ${regex}`);
  }
});

test('UI6: active cur-opt checkbox styling is preserved for profile modal', () => {
  assert.match(uiHtml, /\.cur-opt\s*\{/);
  assert.match(uiHtml, /\.cur-opt\s+input\s*\{/);
  assert.match(uiHtml, /\.cur-opt\s+input:checked\s*\{/);
  assert.match(uiHtml, /\.cur-opt\s+input:checked::after\s*\{/);
});

test('EDIT8: dead selectors removed from designer styles', () => {
  assert.doesNotMatch(
    designerHtml,
    /#drawer\.closed\s+#drawerHead\s+\.chev\.closed\b/,
    'Found unused #drawer.closed #drawerHead .chev.closed rule'
  );
  assert.doesNotMatch(
    designerHtml,
    /#layers\s+\.tag\b/,
    'Found unused #layers .tag rule'
  );
  assert.doesNotMatch(
    designerHtml,
    /#stage\s+\.axis\b(?![-\w])/,
    'Found unused bare #stage .axis rule'
  );
  assert.doesNotMatch(
    designerHtml,
    /\.fsel\b(?![N\w])/,
    'Found unused .fsel class rule'
  );

  // Still preserves needed designer classes
  assert.match(designerHtml, /#stage\s+\.axis-h\b/);
  assert.match(designerHtml, /#stage\s+\.axis-v\b/);
  assert.match(designerHtml, /select\.fselNative\b/);
});

test('BACK12/EDIT7: getDisplays removed from designer preload IPC surface', () => {
  assert.doesNotMatch(
    designerPreload,
    /\bgetDisplays\b/,
    'Designer preload must not expose getDisplays'
  );
  assert.match(designerPreload, /\bgetState\b/);
  assert.match(designerPreload, /\bset\b/);
  assert.match(designerPreload, /\bonState\b/);
});
