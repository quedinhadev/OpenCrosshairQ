// Share codes: versioned, compact crosshair payloads for copy/paste sharing.
// Pure library, dual export (main CJS for tests / browser global CQShare).
// CQ2: = deflate-raw + base64url of the JSON document. Legacy CQ1: (plain
// base64 JSON) remains importable through the UI parser, never rewritten here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CQShare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHARE_PREFIX = 'CQ2:';
  const MAX_SHARE_CODE_BYTES = 2 * 1024 * 1024;
  const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
  // Envelope CQ2 carries the same CQ1 document schema, not a new document type.
  const SUPPORTED_FORMATS = ['CQ1'];

  let zlib = null;
  try { zlib = typeof require === 'function' ? require('node:zlib') : null; } catch { zlib = null; }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }
  function utf8ByteLength(str) {
    return utf8Bytes(str).length;
  }

  function assertBytes(value) {
    if (!(value instanceof Uint8Array)) throw new TypeError('Esperado Uint8Array.');
    return value;
  }

  async function deflateRaw(bytes) {
    assertBytes(bytes);
    if (zlib) return new Uint8Array(zlib.deflateRawSync(Buffer.from(bytes)));
    if (typeof CompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('Compressão indisponível neste ambiente.');
  }

  async function inflateRaw(bytes) {
    assertBytes(bytes);
    if (zlib) return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes), { maxOutputLength: MAX_DOCUMENT_BYTES }));
    if (typeof DecompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_DOCUMENT_BYTES) {
            await reader.cancel();
            throw new Error('Documento excede o tamanho máximo de 20 MiB.');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      return output;
    }
    throw new Error('Descompressão indisponível neste ambiente.');
  }

  function bytesToBase64Url(bytes) {
    assertBytes(bytes);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
      throw new Error('Código inválido (base64).');
    }
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    if (typeof atob === 'function') {
      const binary = atob(padded); // throws on invalid input
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }

  function checkDocumentVersion(parsed) {
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'format') && !SUPPORTED_FORMATS.includes(parsed.format)) {
      throw new Error('Versão de documento não suportada.');
    }
  }

  function normalizePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Documento da mira inválido.');
    checkDocumentVersion(payload);
    if (payload.name !== undefined && (typeof payload.name !== 'string' || payload.name.length > 200)) throw new TypeError('Nome da mira inválido.');
    if (payload.creator !== undefined && (typeof payload.creator !== 'string' || payload.creator.length > 120)) throw new TypeError('Criador da mira inválido.');
    if (payload.layers !== undefined && !Array.isArray(payload.layers)) throw new TypeError('Camadas da mira inválidas.');
    if (payload.model !== undefined && (typeof payload.model !== 'object' || payload.model === null || Array.isArray(payload.model))) throw new TypeError('Modelo da mira inválido.');
    if (payload.drawing !== undefined && (typeof payload.drawing !== 'string' && payload.drawing !== null)) throw new TypeError('Desenho da mira inválido.');
    return payload;
  }

  async function encodeShareCode(payload) {
    normalizePayload(payload);
    const json = utf8Bytes(JSON.stringify(payload));
    if (json.byteLength > MAX_DOCUMENT_BYTES) throw new Error('Documento excede o tamanho máximo de 20 MiB.');
    const deflated = await deflateRaw(json);
    const code = SHARE_PREFIX + bytesToBase64Url(deflated);
    if (utf8ByteLength(code) > MAX_SHARE_CODE_BYTES) throw new Error('Código excede o tamanho máximo de 2 MiB.');
    return code;
  }

  async function decodeShareCode(code) {
    const str = String(code ?? '').trim();
    if (!str) throw new Error('Código vazio.');
    if (utf8ByteLength(str) > MAX_SHARE_CODE_BYTES) throw new Error('Código excede o tamanho máximo de 2 MiB.');
    if (!str.startsWith(SHARE_PREFIX)) throw new Error('Formato não reconhecido; use um código CQ2.');
    const body = str.slice(SHARE_PREFIX.length).trim();
    if (!body) throw new Error('Código vazio.');
    let bytes;
    try { bytes = base64UrlToBytes(body); }
    catch { throw new Error('Código inválido (base64).'); }
    let json;
    try { json = utf8Decode(await inflateRaw(bytes)); }
    catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE' || /20 MiB/.test(error.message)) throw new Error('Documento excede o tamanho máximo de 20 MiB.');
      throw new Error('Código inválido ou corrompido.');
    }
    let parsed;
    try { parsed = JSON.parse(json); }
    catch { throw new Error('Código não contém um documento JSON válido.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Documento inválido.');
    return normalizePayload(parsed);
  }

  return {
    SHARE_PREFIX,
    MAX_SHARE_CODE_BYTES,
    MAX_DOCUMENT_BYTES,
    deflateRaw,
    inflateRaw,
    bytesToBase64Url,
    base64UrlToBytes,
    encodeShareCode,
    decodeShareCode,
  };
});
