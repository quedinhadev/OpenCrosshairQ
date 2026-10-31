// Regressão BACK-14/15/16: regex de processo rejeitava espaços
// ("C:\Program Files\..."); handlers cq:create/delete/rename/configure-profile
// não continham falhas de persistência nem faziam rollback entre commit de
// arquivo de perfil e registry; delete de perfil ATIVO perdia seleção,
// settings pendentes e foco quando a exclusão falhava; create rejeitado no
// rename deixava .tmp que loadProfiles promovia (ressurreição).
// Falhas injetadas via monkey-patch de fs em userData temporário; sem Electron.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const localRequire = createRequire(new URL('../src/main/main.js', import.meta.url));
const { configureProfile, loadProfiles } = require('../src/main/profiles.js');

// ---------------------------------------------------------------------------
// 1. Unit: configureProfile aceita espaços; rejeita segmentos inválidos
// ---------------------------------------------------------------------------
{
  const registry = { default: { id: 'default', settings: {} }, a: { id: 'a', settings: {} } };
  const options = { id: 'a', hideCrosshairWhenUnfocused: true };
  const withSpaces = configureProfile(registry, { ...options, processPath: 'C:\\Program Files\\Game\\game.exe' });
  assert.equal(withSpaces.process.path, 'C:\\Program Files\\Game\\game.exe', 'espaços aceitos');
  assert.equal(withSpaces.process.name, 'game.exe');
  for (const invalid of [
    'C:\\Games \\game.exe',   // segmento termina com espaço (inválido no Windows)
    'C:\\Games.\\game.exe',   // segmento termina com ponto
    'C:\\\\game.exe',         // segmento vazio (backslash duplicado)
    'C:\\dir\\.exe',          // segmento final vazio
    'C:\\game.exe ',          // espaço depois de .exe
    'C:\\CON.exe',            // nome de dispositivo reservado
    'C:\\Games\\COM1.exe',    // nome de dispositivo reservado
    'C:/Jogos/game.exe',      // separador misto
  ]) {
    assert.throws(() => configureProfile(registry, { ...options, processPath: invalid }), /path/i, `deve rejeitar: ${invalid}`);
  }
}

// ---------------------------------------------------------------------------
// Harness main.js (VM + stubs), userData temporário por cenário.
// ---------------------------------------------------------------------------
const source = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');

function boot(dir) {
  const handlers = new Map();
  const events = new Map();
  const sends = [];
  let fgStatus = { available: false, foreground: null, error: null };
  let evalNative = null;
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  class Window {
    constructor() { this.webContents = { send: (channel, state) => sends.push({ channel, state }), setZoomFactor() {} }; }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} loadFile() {} once() {} on() {} setBounds() {}
    isDestroyed() { return false; }
  }
  const app = { whenReady: () => Promise.resolve(), getPath: () => dir, once() {}, on() {} };
  const electron = {
    app, BrowserWindow: Window, Tray: null, Menu: null,
    ipcMain: { on: (c, f) => events.set(c, f), handle: (c, f) => handlers.set(c, f) },
    globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display, on() {} },
  };
  const inputMonitor = () => ({ getStatus: () => ({}), start() {}, stop() {} });
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'electron') return electron;
      if (name === './foreground') return { createForegroundMonitor: (_native, onEvaluate) => { evalNative = onEvaluate; return { getStatus: () => fgStatus, start() {}, stop() {} }; } };
      if (name === './input') return { createInputMonitor: inputMonitor };
      return localRequire(name);
    },
    __dirname: path.resolve('src/main'), console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  return {
    handlers, sends,
    get: () => handlers.get('cq:get-state')(),
    send: (channel, payload) => events.get(channel)({}, payload),
    invoke: (channel, payload) => handlers.get(channel)({}, payload),
    triggerForeground: (status) => { fgStatus = status; evalNative?.(status); },
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-crud-faults-'));
const profileFile = (dir, id) => path.join(dir, 'profiles', `${id}.json`);
const diskProfile = (dir, id) => JSON.parse(fs.readFileSync(profileFile(dir, id), 'utf8'));
const diskJsonFiles = (dir) => fs.readdirSync(path.join(dir, 'profiles')).filter((f) => f.endsWith('.json')).sort();

// Injeta falha em fs[method] quando qualquer argumento contém um dos matches.
function inject(method, matches, message) {
  const original = fs[method];
  fs[method] = function (...args) {
    if (matches.some((m) => args.some((a) => String(a).includes(m)))) throw new Error(message);
    return original.apply(this, args);
  };
  return () => { fs[method] = original; };
}

// Falha condicionada ao conteúdo do arquivo temporário: separa commits que
// escrevem settings.json (persistCurrentProfile/applyProfile vs registry final).
function injectSettingsContent(message, when) {
  const original = fs.renameSync;
  fs.renameSync = function (from, to, ...rest) {
    if (String(to).includes('settings.json')) {
      let content = '';
      try { content = fs.readFileSync(from, 'utf8'); } catch { /* tmp legível por construção */ }
      if (when(content)) throw new Error(message);
    }
    return original.call(this, from, to, ...rest);
  };
  return () => { fs.renameSync = original; };
}

async function newScenario(name) {
  const dir = fs.mkdtempSync(path.join(root, name));
  const env = boot(dir);
  await new Promise((r) => setImmediate(r));
  return { dir, env };
}

try {
  // -------------------------------------------------------------------------
  // 2. create: falha ao persistir perfil ATUAL (persistCurrentProfile) é contida
  // -------------------------------------------------------------------------
  {
    const { dir, env } = await newScenario('create-persist-fail');
    const filesBefore = diskJsonFiles(dir);
    const restore = inject('renameSync', ['default.json'], 'persist current failed');
    try {
      assert.doesNotThrow(() => env.send('cq:create-profile', { name: 'Alvo' }), 'falha contida no handler');
    } finally { restore(); }
    assert.equal(env.get().profiles.currentProfileId, 'default', 'seleção preservada');
    assert.equal(Object.keys(env.get().profiles.profiles).length, 1, 'sem perfil fantasma em memória');
    assert.deepEqual(diskJsonFiles(dir), filesBefore, 'sem arquivo novo em disco');
    assert.match(env.get().validationError, /persist current failed/, 'erro autoritativo publicado');
    assert.match(env.sends.at(-1).state.validationError, /persist current failed/, 'broadcast carrega o erro');
  }

  // -------------------------------------------------------------------------
  // 3. create: falha no commit do registry (settings.json) faz rollback do arquivo novo
  // -------------------------------------------------------------------------
  {
    const { dir, env } = await newScenario('create-registry-fail');
    // Falha SOMENTE no commit do registry que contém o perfil novo; o
    // persistCurrentProfile anterior (também escreve settings.json) precisa ter sucesso.
    const restore = injectSettingsContent('registry commit failed', (c) => c.includes('profile_'));
    try {
      assert.doesNotThrow(() => env.send('cq:create-profile', { name: 'Alvo' }), 'falha contida no handler');
    } finally { restore(); }
    assert.equal(env.get().profiles.currentProfileId, 'default', 'seleção preservada');
    assert.equal(Object.keys(env.get().profiles.profiles).length, 1, 'sem perfil fantasma em memória');
    assert.deepEqual(diskJsonFiles(dir), ['default.json'], 'rollback removeu o arquivo do perfil novo');
    assert.match(env.get().validationError, /registry commit failed/);
    // Recuperação: mesma operação sem falha cria perfil em memória E disco.
    env.send('cq:create-profile', { name: 'Alvo' });
    const id = env.get().profiles.currentProfileId;
    assert.notEqual(id, 'default');
    assert.equal(diskProfile(dir, id).name, 'Alvo', 'sucesso grava arquivo');
    assert.equal(env.get().validationError, null, 'sucesso limpa erro anterior');
  }

  // -------------------------------------------------------------------------
  // 4. rename: falha no arquivo é contida; falha no registry faz rollback do nome
  // -------------------------------------------------------------------------
  {
    const { dir, env } = await newScenario('rename');
    env.send('cq:create-profile', { name: 'Original' });
    const id = env.get().profiles.currentProfileId;
    env.send('cq:set-profile', { id: 'default' });

    let restore = inject('renameSync', [`${id}.json`], 'rename file failed');
    try {
      assert.doesNotThrow(() => env.send('cq:rename-profile', { id, name: 'Novo' }), 'falha contida');
    } finally { restore(); }
    assert.equal(env.get().profiles.profiles[id].name, 'Original', 'memória preservada');
    assert.equal(diskProfile(dir, id).name, 'Original', 'disco preservado');
    assert.match(env.get().validationError, /rename file failed/);

    restore = inject('renameSync', ['settings.json'], 'rename registry failed');
    try {
      assert.doesNotThrow(() => env.send('cq:rename-profile', { id, name: 'Novo' }), 'falha contida');
    } finally { restore(); }
    assert.equal(env.get().profiles.profiles[id].name, 'Original', 'memória sem rename órfão');
    assert.equal(diskProfile(dir, id).name, 'Original', 'rollback restaurou nome no arquivo');
    assert.match(env.get().validationError, /rename registry failed/);

    env.send('cq:rename-profile', { id, name: 'Novo' });
    assert.equal(env.get().profiles.profiles[id].name, 'Novo');
    assert.equal(diskProfile(dir, id).name, 'Novo');
    assert.equal(env.get().validationError, null, 'sucesso limpa erro');
  }

  // -------------------------------------------------------------------------
  // 5. delete: falha na exclusão do arquivo é contida; falha no registry restaura
  // -------------------------------------------------------------------------
  {
    const { dir, env } = await newScenario('delete');
    env.send('cq:create-profile', { name: 'Vitima' });
    const id = env.get().profiles.currentProfileId;
    env.send('cq:set-profile', { id: 'default' });
    const victimDisk = diskProfile(dir, id);

    let restore = inject('unlinkSync', [`${id}.json`], 'unlink failed');
    try {
      assert.doesNotThrow(() => env.send('cq:delete-profile', { id }), 'falha contida');
    } finally { restore(); }
    assert.ok(Object.hasOwn(env.get().profiles.profiles, id), 'perfil preservado em memória');
    assert.ok(fs.existsSync(profileFile(dir, id)), 'arquivo preservado');
    assert.match(env.get().validationError, /unlink failed/);

    restore = inject('renameSync', ['settings.json'], 'delete registry failed');
    try {
      assert.doesNotThrow(() => env.send('cq:delete-profile', { id }), 'falha contida');
    } finally { restore(); }
    assert.ok(Object.hasOwn(env.get().profiles.profiles, id), 'registry em memória intacto');
    assert.deepEqual(diskProfile(dir, id), victimDisk, 'rollback restaurou arquivo excluído');
    assert.match(env.get().validationError, /delete registry failed/);

    env.send('cq:delete-profile', { id });
    assert.ok(!Object.hasOwn(env.get().profiles.profiles, id), 'perfil removido da memória');
    assert.ok(!fs.existsSync(profileFile(dir, id)), 'arquivo removido');
    assert.equal(env.get().validationError, null, 'sucesso limpa erro');
  }

  // -------------------------------------------------------------------------
  // 5b. delete ATIVO: falha no commit do registry devolve o snapshot COMPLETO
  //     (seleção, settings pendentes não salvos, foco) e o arquivo
  // -------------------------------------------------------------------------
  {
    const { dir, env } = await newScenario('delete-active-registry');
    env.send('cq:create-profile', { name: 'VitimaAtiva' });
    const id = env.get().profiles.currentProfileId;
    await env.invoke('cq:configure-profile', { id, processPath: 'C:\\Games\\game.exe', hideCrosshairWhenUnfocused: true });
    env.triggerForeground({ available: true, foreground: { executablePath: 'C:\\Other.exe' }, error: null });
    assert.equal(env.get().profileInFocus, false, 'setup: perfil ativo fora de foco');
    env.send('cq:set', { scale: 7 }); // pendente: debounce stubado, não foi pro arquivo
    assert.equal(env.get().scale, 7);

    // Falha SOMENTE no commit do registry sem o perfil (applyProfile default e
    // restauração escrevem settings.json COM o perfil e precisam passar).
    const restore = injectSettingsContent('delete registry failed', (c) => !c.includes(id));
    try {
      assert.doesNotThrow(() => env.send('cq:delete-profile', { id }), 'falha contida');
    } finally { restore(); }
    assert.equal(env.get().profiles.currentProfileId, id, 'seleção restaurada para o perfil ativo');
    assert.equal(env.get().scale, 7, 'settings pendente (scale 7) restaurado');
    assert.equal(env.get().profileInFocus, false, 'foco restaurado');
    assert.ok(Object.hasOwn(env.get().profiles.profiles, id), 'perfil preservado na memória');
    assert.ok(fs.existsSync(profileFile(dir, id)), 'arquivo restaurado em disco');
    assert.equal(diskProfile(dir, id).settings.scale, 1, 'pendente nunca vaza para o arquivo');
    assert.match(env.get().validationError, /delete registry failed/);

    env.send('cq:delete-profile', { id });
    assert.equal(env.get().profiles.currentProfileId, 'default', 'retry com sucesso seleciona default');
    assert.equal(env.get().scale, 1, 'default aplicado após exclusão definitiva');
    assert.ok(!fs.existsSync(profileFile(dir, id)), 'arquivo removido');
    assert.ok(!Object.hasOwn(env.get().profiles.profiles, id), 'registry limpo');
    assert.equal(env.get().validationError, null);
  }

  // -------------------------------------------------------------------------
  // 5c. delete ATIVO: falha no unlink (após applyProfile default já commitado)
  //     também devolve seleção/settings pendentes/foco
  // -------------------------------------------------------------------------
  {
    const { dir, env } = await newScenario('delete-active-unlink');
    env.send('cq:create-profile', { name: 'VitimaAtiva' });
    const id = env.get().profiles.currentProfileId;
    await env.invoke('cq:configure-profile', { id, processPath: 'C:\\Games\\game.exe', hideCrosshairWhenUnfocused: true });
    env.triggerForeground({ available: true, foreground: { executablePath: 'C:\\Other.exe' }, error: null });
    assert.equal(env.get().profileInFocus, false, 'setup: foco false');
    env.send('cq:set', { scale: 7 });
    assert.equal(env.get().scale, 7);

    const restore = inject('unlinkSync', [`${id}.json`], 'unlink failed');
    try {
      assert.doesNotThrow(() => env.send('cq:delete-profile', { id }), 'falha contida');
    } finally { restore(); }
    assert.equal(env.get().profiles.currentProfileId, id, 'seleção restaurada (applyProfile default foi desfeito)');
    assert.equal(env.get().scale, 7, 'settings pendente restaurado');
    assert.equal(env.get().profileInFocus, false, 'foco restaurado (false->true->false)');
    assert.ok(fs.existsSync(profileFile(dir, id)), 'arquivo preservado');
    assert.match(env.get().validationError, /unlink failed/);

    env.send('cq:delete-profile', { id });
    assert.ok(!fs.existsSync(profileFile(dir, id)), 'retry exclui arquivo');
    assert.equal(env.get().profiles.currentProfileId, 'default');
    assert.equal(env.get().validationError, null);
  }

  // -------------------------------------------------------------------------
  // 6. configure: falha no commit do registry rejeita invoke e reverte o arquivo
  // -------------------------------------------------------------------------
  {
    const { dir, env } = await newScenario('configure');
    env.send('cq:create-profile', { name: 'Jogo' });
    const id = env.get().profiles.currentProfileId;
    env.send('cq:set-profile', { id: 'default' });
    const payload = { id, processPath: 'C:\\Program Files\\Game\\game.exe', hideCrosshairWhenUnfocused: true };

    const restore = inject('renameSync', ['settings.json'], 'configure registry failed');
    try {
      await assert.rejects(() => Promise.resolve().then(() => env.invoke('cq:configure-profile', payload)), /configure registry failed/, 'invoke rejeita');
    } finally { restore(); }
    assert.equal(env.get().profiles.profiles[id].process, null, 'memória sem binding órfão');
    assert.equal(diskProfile(dir, id).process ?? null, null, 'rollback reverteu arquivo');

    const configured = await env.invoke('cq:configure-profile', payload);
    assert.equal(configured.process.path, 'C:\\Program Files\\Game\\game.exe');
    assert.equal(env.get().profiles.profiles[id].process.path, 'C:\\Program Files\\Game\\game.exe', 'memória atualizada');
    assert.equal(diskProfile(dir, id).process.path, 'C:\\Program Files\\Game\\game.exe', 'disco atualizado');
  }

  // -------------------------------------------------------------------------
  // 7. create rejeitado no rename não pode deixar .tmp que loadProfiles
  //    promove (ressurreição de perfil rejeitado)
  // -------------------------------------------------------------------------
  {
    const { dir, env } = await newScenario('create-tmp-resurrect');
    const restore = inject('renameSync', ['profile_'], 'create rename failed');
    try {
      assert.doesNotThrow(() => env.send('cq:create-profile', { name: 'Rejeitado' }), 'falha contida');
    } finally { restore(); }
    assert.match(env.get().validationError, /create rename failed/);
    assert.equal(env.get().profiles.currentProfileId, 'default', 'sem perfil fantasma em memória');
    const files = fs.readdirSync(path.join(dir, 'profiles'));
    assert.ok(files.every((f) => !f.startsWith('profile_')), 'nem .json nem .json.tmp do perfil rejeitado');
    const reloaded = loadProfiles(dir);
    assert.deepEqual(Object.keys(reloaded.profiles).sort(), ['default'], 'loadProfiles não ressuscita perfil rejeitado');
  }

  console.log('PASS: profiles-crud-faults (espaços em path + contenção + rollback duplo-commit + delete ativo + tmp órfão)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
