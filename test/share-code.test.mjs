// Run from app: node test/share-code.test.mjs
// Covers the CQ2 share code format (deflate + base64url) in Node (zlib path);
// the browser CompressionStream path shares the same contract.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Share = require('../src/shared/share.js');
const L = require('../src/shared/layers.js');

const assertBytesContract = async () => {
  await assert.rejects(() => Share.deflateRaw('nope'), TypeError);
  await assert.rejects(() => Share.inflateRaw(null), TypeError);
};

const roundtrip = async () => {
  const payload = {
    format: 'CQ1',
    id: 'custom-abc',
    name: 'Mira Têşte ✅',
    creator: 'Zé <b>negrito</b>',
    model: L.defaultModel ? L.defaultModel() : {},
    layers: [L.newModelLayer(), L.newShapeLayer()],
  };
  const code = await Share.encodeShareCode(payload);
  assert.ok(code.startsWith('CQ2:'), 'code must carry the CQ2 prefix');
  assert.doesNotMatch(code, /[+/=]/, 'code must be base64url only');
  const decoded = await Share.decodeShareCode(code);
  assert.deepEqual(decoded, payload, 'roundtrip preserves the document');
};

const compact = async () => {
  const repetitive = [];
  for (let i = 0; i < 3000; i++) repetitive.push(L.newModelLayer());
  const payload = { format: 'CQ1', name: 'Bulk', layers: repetitive };
  const code = await Share.encodeShareCode(payload);
  const legacy = 'CQ1:' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  assert.ok(code.length < legacy.length / 2, `CQ2 must compress repetitive JSON (${code.length} < ${legacy.length / 2})`);
  const decoded = await Share.decodeShareCode(code);
  assert.equal(decoded.layers.length, repetitive.length, 'many layers survive roundtrip');
};

const rejectInvalidEncode = async () => {
  await assert.rejects(() => Share.encodeShareCode(null), TypeError);
  await assert.rejects(() => Share.encodeShareCode([]), TypeError);
  await assert.rejects(() => Share.encodeShareCode({ layers: 'nope' }), TypeError);
  await assert.rejects(() => Share.encodeShareCode({ name: 42 }), TypeError);
  await assert.rejects(() => Share.encodeShareCode({ name: 'x'.repeat(201) }), TypeError);
  await assert.rejects(() => Share.encodeShareCode({ model: 'nope' }), TypeError);
  await assert.rejects(() => Share.encodeShareCode({ drawing: 7 }), TypeError);
  await assert.rejects(() => Share.encodeShareCode({ format: 'CQ9' }), /não suportada/);
};

const rejectInvalidDecode = async () => {
  await assert.rejects(() => Share.decodeShareCode(''), /vazio/);
  await assert.rejects(() => Share.decodeShareCode('   '), /vazio/);
  await assert.rejects(() => Share.decodeShareCode('CQ2:'), /vazio/);
  await assert.rejects(() => Share.decodeShareCode('hello'), /não reconhecido/);
  await assert.rejects(() => Share.decodeShareCode('CQ1:AAAA'), /não reconhecido/);
  await assert.rejects(() => Share.decodeShareCode('CQ2:!!!!'), /base64/);
  await assert.rejects(() => Share.decodeShareCode('CQ9:AAAA'), /não reconhecido/);
  // Valid deflate of invalid JSON.
  const notJson = 'CQ2:' + Share.bytesToBase64Url(await Share.deflateRaw(new TextEncoder().encode('not json')));
  await assert.rejects(() => Share.decodeShareCode(notJson), /JSON/);
  // Valid JSON that is not an object.
  const arrayDoc = 'CQ2:' + Share.bytesToBase64Url(await Share.deflateRaw(new TextEncoder().encode('[1,2]')));
  await assert.rejects(() => Share.decodeShareCode(arrayDoc), /Documento inválido/);
  // Future document version inside a valid CQ2 envelope.
  const future = 'CQ2:' + Share.bytesToBase64Url(await Share.deflateRaw(new TextEncoder().encode('{"format":"CQ9"}')));
  await assert.rejects(() => Share.decodeShareCode(future), /não suportada/);
};

const truncateFails = async () => {
  const payload = { format: 'CQ1', name: 'Trunc', layers: [L.newModelLayer()] };
  const code = await Share.encodeShareCode(payload);
  const body = code.slice('CQ2:'.length);
  await assert.rejects(() => Share.decodeShareCode('CQ2:' + body.slice(0, Math.floor(body.length / 2))), /base64|corrompido|JSON/);
};

const sizeLimit = async () => {
  // Incompressible random data: base64 of 3 MiB random bytes stays above 2 MiB after deflate.
  const random = require('node:crypto').randomBytes(3 * 1024 * 1024).toString('base64');
  const payload = { format: 'CQ1', name: 'Huge', layers: [{ ...L.newDrawLayer(`data:image/png;base64,${random}`, 10, 10) }] };
  await assert.rejects(() => Share.encodeShareCode(payload), /2 MiB/);
};

// Load exactly as Chromium does: no require/module, real Web Streams APIs.
const vm = require('node:vm');
const browser = { self: {}, Uint8Array, Blob, Response, CompressionStream, DecompressionStream, TextEncoder, TextDecoder, btoa, atob };
vm.runInNewContext(require('node:fs').readFileSync(new URL('../src/shared/share.js', import.meta.url), 'utf8'), browser);
const WebShare = browser.self.CQShare;
const payload = { format: 'CQ1', name: 'ação ♥', layers: [] };
assert.deepEqual(JSON.parse(JSON.stringify(await WebShare.decodeShareCode(await Share.encodeShareCode(payload)))), payload);
assert.deepEqual(await Share.decodeShareCode(await WebShare.encodeShareCode(payload)), payload);
const rawCode = async json => 'CQ2:' + Share.bytesToBase64Url(await Share.deflateRaw(new TextEncoder().encode(json)));
for (const codec of [Share, WebShare]) {
  const overhead = JSON.stringify({ format: 'CQ1', padding: '' }).length;
  const exact = { format: 'CQ1', padding: 'x'.repeat(Share.MAX_DOCUMENT_BYTES - overhead) };
  const exactCode = await codec.encodeShareCode(exact);
  assert.equal((await codec.decodeShareCode(exactCode)).padding.length, exact.padding.length);
  exact.padding += 'x';
  await assert.rejects(() => codec.encodeShareCode(exact), /20 MiB/);
  const bomb = await rawCode(JSON.stringify(exact));
  assert.ok(bomb.length < 100000, 'small compressed input exceeds document budget');
  await assert.rejects(() => codec.decodeShareCode(bomb), /20 MiB/);
  for (const invalid of [{ layers: 'bad' }, { model: [] }, { name: 42 }, ...['CQ2', false, 0, '', null].map(format => ({ format }))]) {
    await assert.rejects(() => codec.encodeShareCode(invalid));
    const invalidCode = await rawCode(JSON.stringify(invalid));
    await assert.rejects(() => codec.decodeShareCode(invalidCode));
  }
}

await assertBytesContract();
await roundtrip();
await compact();
await rejectInvalidEncode();
await rejectInvalidDecode();
await truncateFails();
await sizeLimit();
console.log('PASS: share code CQ2 encode/decode, limits, and rejection paths');
