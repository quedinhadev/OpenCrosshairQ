// Bandeja + início automático: node --test puro, sem Electron e sem registro real
// (startup recebe um app falso; tray recebe Tray/Menu falsos).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createTray, willMinimizeToTray } = require('../src/main/tray.js');
const { createStartup } = require('../src/main/startup.js');
const { createStore } = require('../src/main/state.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-tray-'));
process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const registry = { profiles: { default: { id: 'default' } } };

// --- state: minimizeToTray default true, persistido, validado.
{
  const store = createStore(dir, registry);
  assert.equal(store.get().minimizeToTray, true, 'default true');
  store.set({ minimizeToTray: false });
  assert.equal(createStore(dir, registry).get().minimizeToTray, false, 'persistido e restaurado');
  for (const bad of ['on', 0, null, []]) {
    assert.throws(() => store.set({ minimizeToTray: bad }), TypeError, JSON.stringify(bad));
  }
  assert.equal(store.get().minimizeToTray, false, 'patch inválido não altera estado');
}

// --- decisão de minimizar: exige preferência E bandeja funcional.
assert.equal(willMinimizeToTray({ minimizeToTray: false }, { available: true }), false, 'opção off não esconde');
assert.equal(willMinimizeToTray({ minimizeToTray: true }, { available: false }), false, 'erro na bandeja não esconde');
assert.equal(willMinimizeToTray({ minimizeToTray: true }, null), false, 'sem bandeja não esconde');
assert.equal(willMinimizeToTray(null, { available: true }), false, 'sem preferência não esconde');
assert.equal(willMinimizeToTray({ minimizeToTray: true }, { available: true }), true, 'caso feliz esconde');

// --- bandeja funcional: ícone real existe, clique restaura, menu age, destroy limpa.
{
  let instance = null;
  const events = [];
  class FakeTray {
    constructor(icon) { this.icon = icon; this.handlers = {}; this.menus = []; instance = this; }
    setToolTip(t) { this.tooltip = t; }
    setContextMenu(m) { this.menus.push(m); }
    on(name, fn) { this.handlers[name] = fn; }
    destroy() { this.destroyed = true; }
  }
  const FakeMenu = { buildFromTemplate: (template) => ({ template }) };
  let hidden = false;
  const tray = createTray({ Tray: FakeTray, Menu: FakeMenu }, {
    iconPath: path.join(here, '..', 'assets', 'icon.ico'),
    getHidden: () => hidden,
    toggleCrosshair: () => { hidden = !hidden; events.push('toggle'); },
    restore: () => events.push('restore'),
    quit: () => events.push('quit'),
  });
  assert.equal(tray.available, true, 'bandeja disponível');
  assert.equal(tray.error, null);
  assert.equal(instance.icon.endsWith('icon.ico'), true, 'ícone assets/icon.ico');
  assert.equal(instance.tooltip, 'OpenCrosshairQ');
  instance.handlers.click();
  instance.handlers['double-click']();
  assert.deepEqual(events, ['restore', 'restore'], 'click e double-click restauram');
  const menu = () => instance.menus.at(-1).template;
  assert.equal(menu()[0].label, 'Abrir OpenCrosshairQ');
  menu()[0].click();
  assert.deepEqual(events.at(-1), 'restore', 'menu abrir restaura');
  assert.equal(menu()[2].label, 'Ocultar mira', 'rótulo segue mira visível');
  menu()[2].click();
  assert.deepEqual(events.at(-1), 'toggle', 'menu alterna mira');
  hidden = true;
  tray.refresh();
  assert.equal(menu()[2].label, 'Exibir mira', 'refresh re-rotula com mira oculta');
  menu()[4].click();
  assert.deepEqual(events.at(-1), 'quit', 'menu sair encerra');
  tray.destroy();
  assert.equal(instance.destroyed, true, 'destroy remove a bandeja');
}

// --- bandeja com erro: indisponível, sem lançar, minimizar segue normal.
{
  const boom = createTray({ Tray: class { constructor() { throw new Error('sem shell'); } }, Menu: { buildFromTemplate() {} } }, {
    iconPath: path.join(here, '..', 'assets', 'icon.ico'), getHidden: () => false, toggleCrosshair() {}, restore() {}, quit() {},
  });
  assert.equal(boom.available, false, 'construtor falhando desabilita');
  assert.match(boom.error, /sem shell/);
  boom.refresh(); boom.destroy();
  const missingIcon = createTray({ Tray: class {}, Menu: { buildFromTemplate() {} } }, {
    iconPath: 'Z:\\inexistente.ico', getHidden: () => false, toggleCrosshair() {}, restore() {}, quit() {},
  });
  assert.equal(missingIcon.available, false, 'ícone ausente desabilita');
  const noApi = createTray({ Tray: null, Menu: null }, { iconPath: path.join(here, '..', 'assets', 'icon.ico') });
  assert.equal(noApi.available, false, 'API ausente desabilita');
  assert.equal(willMinimizeToTray({ minimizeToTray: true }, boom), false, 'erro na bandeja não esconde a janela');
}

// --- app falso: nenhum teste toca o registro real do Windows. Entradas
// {name, path, args, scope, enabled} modelam Run key + StartupApproved;
// entries[].args guardam tokens reais; launchItems[].args omitem switches:
// set openAtLogin:false remove a entrada (name+user); openAtLogin:true faz
// upsert com enabled default true (escreve StartupApproved). get retorna
// launchItems filtradas pelo path (qualquer args) e executableWillLaunchAtLogin
// agregando mesmo exe, qualquer args, apenas aprovadas (user OU machine).
// failGetFrom/failGetCount: N leituras falham a partir da k-ésima; failSet:
// toda escrita lança; ignoreSet: escrita aceita mas não aplicada (SO não
// confirma). Electron 31.7.7 browser_win.cc: FormatCommandLineString concatena
// sem autoquote; GetLoginItemSettingsHelper faz parse e compara só o exe.
// Chromium GetArgs retorna apenas posicionais; switches --... não aparecem
// em launchItems[].args, mesmo que estejam no comando armazenado.
// ponytail: parser cobre exe entre aspas + args simples usados aqui; não é
// emulação geral de CommandLineToArgvW (expandir só se o contrato ganhar args).
const parseCommand = (command) => {
  const tokens = command.match(/"[^"]*"|[^\s]+/g) ?? [];
  return { path: tokens[0]?.replace(/^"|"$/g, '') ?? '', args: tokens.slice(1).map(s => s.replace(/^"|"$/g, '')) };
};
const sameWindows = (a, b) => a.toLowerCase() === b.toLowerCase();
function fakeApp({ isPackaged, entries = [], failGetFrom = Infinity, failGetCount = 0, failSet = false, failSetAt = Infinity, ignoreSet = false, ignoreSetAt = Infinity }) {
  const calls = [];
  let gets = 0, failedGets = 0, sets = 0;
  return {
    calls, entries, isPackaged,
    setLoginItemSettings(options) {
      calls.push(['set', { ...options }]);
      sets++;
      if (failSet || sets === failSetAt) throw new Error('registro travado');
      if (ignoreSet || sets === ignoreSetAt) return;
      const name = options.name ?? 'LegadoAUMID';
      const i = entries.findIndex((e) => sameWindows(e.name, name) && e.scope === 'user');
      if (options.openAtLogin === false) { if (i >= 0) entries.splice(i, 1); return; }
      const command = [options.path, ...(options.args ?? [])].join(' ');
      const entry = { name, ...parseCommand(command), scope: 'user', enabled: options.enabled ?? true };
      if (i >= 0) entries[i] = entry; else entries.push(entry);
    },
    getLoginItemSettings(options) {
      calls.push(['get', { ...options }]);
      if (gets >= failGetFrom && failedGets < failGetCount) { failedGets++; throw new Error('leitura indisponível'); }
      gets++;
      const lookup = parseCommand(options.path).path;
      const matching = entries.filter(e => sameWindows(e.path, lookup));
      return {
        // Electron legado consulta somente o AUMID, não o name explícito.
        openAtLogin: matching.some(e => e.name === 'LegadoAUMID' && JSON.stringify(e.args) === JSON.stringify(options.args)),
        executableWillLaunchAtLogin: matching.some(e => e.enabled === true),
        launchItems: matching.map(e => ({ ...e, args: e.args.filter(arg => !arg.startsWith('--')) })),
      };
    },
  };
}
const exe = 'C:\\Program Files\\OpenCrosshairQ\\OpenCrosshairQ.exe';
const portableExe = 'D:\\Portateis com espaços\\OpenCrosshairQ-Portable.exe';
const ours = (enabled) => ({ name: 'OpenCrosshairQ', path: exe, args: [], scope: 'user', enabled });

// --- gate: fora do Windows e dev nunca chamam a API (não registrar electron.exe).
{
  const linux = fakeApp({ isPackaged: true });
  const s = createStartup({ app: linux, platform: 'linux', execPath: exe });
  assert.deepEqual(s.getStatus(), { supported: false, available: false, configured: null, approved: null, enabled: null, error: 'Início automático é suportado apenas no Windows.' });
  assert.deepEqual(s.set(true), { ok: false, configured: null, approved: null, enabled: null, error: 'Início automático é suportado apenas no Windows.' });
  assert.equal(linux.calls.length, 0, 'fora do Windows não toca o registro');
}
{
  const dev = fakeApp({ isPackaged: false });
  const s = createStartup({ app: dev, platform: 'win32', execPath: 'C:\\dev\\node_modules\\electron\\dist\\electron.exe' });
  assert.deepEqual(s.getStatus(), { supported: true, available: false, configured: null, approved: null, enabled: null, error: 'Indisponível em desenvolvimento.' });
  assert.deepEqual(s.set(true), { ok: false, configured: null, approved: null, enabled: null, error: 'Indisponível em desenvolvimento.' });
  assert.equal(dev.calls.length, 0, 'dev não registra electron.exe');
}

// --- instalado: set com name explícito + aprovação; get com o MESMO path/args.
{
  const app = fakeApp({ isPackaged: true });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  assert.deepEqual(s.getStatus(), { supported: true, available: true, configured: false, approved: null, enabled: false, error: null }, 'status inicial real');
  assert.deepEqual(s.set(true), { ok: true, configured: true, approved: true, enabled: true, error: null }, 'ligar cria entrada aprovada');
  const set = app.calls.find(([op]) => op === 'set')[1];
  const get = app.calls.find(([op]) => op === 'get')[1];
  assert.deepEqual(set, { openAtLogin: true, path: `"${exe}"`, args: [], name: 'OpenCrosshairQ', enabled: true }, 'registra executável instalado com aspas e name explícito');
  assert.equal(app.entries[0].path, exe, 'comando serializado retorna executável inteiro SEM aspas');
  assert.deepEqual({ path: get.path, args: get.args }, { path: set.path, args: set.args }, 'get usa o mesmo path/args do set');
  assert.deepEqual(s.set(false), { ok: true, configured: false, approved: null, enabled: false, error: null }, 'desligar remove a entrada NOSSA');
  assert.equal(app.entries.length, 0, 'entrada removida');
}

// --- registrada mas NÃO aprovada (Task Manager desativou): dimensões
// separadas no status; set(true) conserta a aprovação da entrada existente.
{
  const app = fakeApp({ isPackaged: true, entries: [ours(false)] });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const st = s.getStatus();
  assert.deepEqual([st.configured, st.approved, st.enabled], [true, false, false], 'configurada, não aprovada: efetivo false sem colapsar dimensões');
  assert.deepEqual(s.set(true), { ok: true, configured: true, approved: true, enabled: true, error: null }, 'ligar re-aprova a entrada existente');
  assert.equal(app.entries.length, 1, 'nenhuma entrada duplicada');
  assert.equal(app.entries[0].enabled, true, 'aprovação escrita');
}

// --- MAJOR (repro): configurada true + aprovação false, set(true) com leitura
// pós-set falhando UMA vez → rollback preserva o PAR (entrada + aprovação
// anterior). Código antigo: prior era só o efetivo (false) → rollback
// openAtLogin:false REMOVIA a entrada configurada.
{
  const app = fakeApp({ isPackaged: true, entries: [ours(false)], failGetFrom: 1, failGetCount: 1 });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(true);
  assert.equal(result.ok, false, 'leitura pós-set falhando é falha');
  assert.deepEqual([result.configured, result.approved, result.enabled], [true, false, false], 'AMBOS preservados: entrada existe e segue não aprovada');
  assert.ok(result.error, 'erro reportado');
  const sets = app.calls.filter(([op]) => op === 'set').map(([, o]) => o);
  assert.equal(sets.length, 2, 'aplicação + rollback');
  assert.deepEqual({ openAtLogin: sets[1].openAtLogin, enabled: sets[1].enabled }, { openAtLogin: true, enabled: false }, 'rollback reescreve a entrada com a aprovação ANTERIOR, não openAtLogin:false às cegas');
  assert.equal(app.entries.length, 1, 'entrada configurada não foi removida');
  assert.equal(app.entries[0].enabled, false, 'aprovação anterior restaurada');
}

// --- inverso: entrada aprovada (efetivo true), set(false) com leitura
// pós-set falhando uma vez → rollback RE-CRIA a entrada com a aprovação
// anterior (código antigo gravaria openAtLogin:false e perderia tudo).
{
  const app = fakeApp({ isPackaged: true, entries: [ours(true)], failGetFrom: 1, failGetCount: 1 });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(false);
  assert.equal(result.ok, false);
  assert.deepEqual([result.configured, result.approved, result.enabled], [true, true, true], 'estado anterior (configurada + aprovada) restaurado');
  assert.deepEqual(s.getStatus(), { supported: true, available: true, configured: true, approved: true, enabled: true, error: null }, 'registro segue igual ao antes');
  assert.equal(app.entries[0].enabled, true, 'aprovação anterior preservada');
}

// --- SO não confirma a escrita (set aceito, registro ignora): falha com
// estado real reportado; rollback volta ao anterior.
{
  const app = fakeApp({ isPackaged: true, ignoreSet: true });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(true);
  assert.equal(result.ok, false, 'sistema não confirmou');
  assert.deepEqual([result.configured, result.approved, result.enabled], [false, null, false], 'retorna estado real, não o pedido');
  assert.ok(result.error);
  const sets = app.calls.filter(([op]) => op === 'set').map(([, o]) => o);
  assert.equal(sets.length, 2, 'aplicação + rollback');
  assert.equal(sets[1].openAtLogin, false, 'anterior não-configurado: rollback é remoção');
}

// --- set lançando: rollback tentado mesmo com API falhando; error preservado.
{
  const app = fakeApp({ isPackaged: true, failSet: true });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(true);
  assert.equal(result.ok, false);
  assert.match(result.error, /registro travado/);
  assert.equal(app.calls.filter(([op]) => op === 'set').at(-1)[1].openAtLogin, false, 'tentativa de rollback mesmo com API falhando');
}

// --- escrita + rollback falhando + releitura falhando: desconhecido (null).
{
  const app = fakeApp({ isPackaged: true, failSet: true, failGetFrom: 1, failGetCount: 1 });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(true);
  assert.equal(result.ok, false);
  assert.deepEqual([result.configured, result.approved, result.enabled], [null, null, null], 'releitura falhando = desconhecido, não false');
  assert.match(result.error, /registro travado/);
  assert.match(result.error, /Rollback falhou/);
  assert.match(result.error, /Restauração não verificável/);
}

// --- leitura sempre falhando: desconhecido (null), nunca false; nada escrito.
{
  const app = fakeApp({ isPackaged: true, failGetFrom: 0, failGetCount: Infinity });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const status = s.getStatus();
  assert.equal(status.supported, true);
  assert.equal(status.available, true, 'API presente; só a leitura falhou');
  assert.deepEqual([status.configured, status.approved, status.enabled], [null, null, null], 'leitura falhando = desconhecido, não false');
  assert.ok(status.error, 'erro explícito quando desconhecido');
  const result = s.set(true);
  assert.equal(result.ok, false);
  assert.deepEqual([result.configured, result.approved, result.enabled], [null, null, null], 'set sem estado inicial conhecido não afirma valor');
  assert.equal(app.calls.filter(([op]) => op === 'set').length, 0, 'estado inicial desconhecido: NADA escrito');
}

// --- respostas sem launchItems / aprovação não boolean: estado não
// verificável → falha ANTES de qualquer escrita.
{
  const app = {
    isPackaged: true, calls: [],
    setLoginItemSettings(o) { app.calls.push(['set', o]); },
    getLoginItemSettings(o) { app.calls.push(['get', o]); return { openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [{ name: 'OpenCrosshairQ', path: exe, args: [], scope: 'user' }] }; },
  };
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(true);
  assert.equal(result.ok, false, 'aprovação não verificável: não adivinha');
  assert.deepEqual([result.configured, result.approved, result.enabled], [null, null, null]);
  assert.match(result.error, /aprovação não verificável/);
  assert.equal(app.calls.filter(([op]) => op === 'set').length, 0, 'nada escrito sem aprovação confirmada');
  const noItems = {
    isPackaged: true, calls: [],
    setLoginItemSettings(o) { noItems.calls.push(['set', o]); },
    getLoginItemSettings(o) { noItems.calls.push(['get', o]); return { openAtLogin: false, executableWillLaunchAtLogin: false }; },
  };
  const s2 = createStartup({ app: noItems, platform: 'win32', execPath: exe, env: {} });
  assert.equal(s2.set(true).ok, false, 'sem launchItems: estado não verificável');
  assert.equal(noItems.calls.filter(([op]) => op === 'set').length, 0, 'nada escrito');
}

// --- no-op legítimo: estado NOSSO já entrega o pedido → zero escritas.
{
  const app = fakeApp({ isPackaged: true, entries: [ours(true)] });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(true);
  assert.deepEqual(result, { ok: true, configured: true, approved: true, enabled: true, error: null });
  assert.equal(app.calls.filter(([op]) => op === 'set').length, 0, 'já ligado: nenhuma escrita');
}
{
  const app = fakeApp({ isPackaged: true });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(false);
  assert.deepEqual(result, { ok: true, configured: false, approved: null, enabled: false, error: null });
  assert.equal(app.calls.filter(([op]) => op === 'set').length, 0, 'já desligado: nenhuma escrita');
}
{
  // Desligado EFETIVO via entrada própria não aprovada: set(false) é no-op e
  // PRESERVA a entrada (dimension própria intacta).
  const app = fakeApp({ isPackaged: true, entries: [ours(false)] });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(false);
  assert.deepEqual(result, { ok: true, configured: true, approved: false, enabled: false, error: null });
  assert.equal(app.calls.filter(([op]) => op === 'set').length, 0, 'efetivo já false: nenhuma escrita');
  assert.equal(app.entries.length, 1, 'entrada não aprovada preservada');
}

// --- no-op NÃO inventa sucesso com registro divergente: efetivo true por
// entrada ALHEIA (outro nome, mesmo exe) e nossa ausente → set(true) escreve
// a NOSSA; alheia intacta.
{
  const alien = { name: 'LegadoAUMID', path: exe, args: ['--auto'], scope: 'user', enabled: true };
  const app = fakeApp({ isPackaged: true, entries: [alien] });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  assert.equal(s.getStatus().enabled, true, 'efetivo via entrada alheia');
  assert.equal(s.getStatus().configured, false, 'nossa entrada ausente');
  const result = s.set(true);
  assert.equal(result.ok, true);
  assert.equal(result.configured, true, 'sem no-op falso: criou a entrada NOSSA');
  assert.deepEqual(app.entries[0], alien, 'entrada alheia não tocada');
  assert.equal(app.entries.length, 2, 'nossa + alheia coexistem');
}

// --- desligar impossível (causa alheia machine): falha honesta com estado
// real; entrada machine NUNCA tocada.
{
  const machine = { name: 'Deploy', path: exe, args: [], scope: 'machine', enabled: true };
  const app = fakeApp({ isPackaged: true, entries: [machine] });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  const result = s.set(false);
  assert.equal(result.ok, false, 'causa fora do nosso controle: falha honesta');
  assert.equal(result.enabled, true, 'ainda lança de verdade');
  assert.deepEqual([result.configured, result.approved], [false, null]);
  assert.ok(result.error);
  assert.deepEqual(app.entries[0], machine, 'entrada machine não tocada');
}

// --- portable: registra PORTABLE_EXECUTABLE_FILE, não o executável temporário.
{
  const app = fakeApp({ isPackaged: true });
  const s = createStartup({
    app, platform: 'win32',
    execPath: 'C:\\Usuário\\Temp\\ extracted\\app.exe',
    env: { PORTABLE_EXECUTABLE_FILE: portableExe },
  });
  s.set(true);
  assert.equal(app.calls.find(([op]) => op === 'set')[1].path, `"${portableExe}"`, 'portable registra o .exe portátil entre aspas');
  assert.equal(app.entries[0].path, portableExe, 'entrada criada aponta para o portátil');
  for (const [, options] of app.calls) assert.deepEqual({ path: options.path, args: options.args }, { path: `"${portableExe}"`, args: [] }, 'portable: MESMO comando nativo em todas as leituras/escritas');
  assert.notEqual(app.calls.find(([op]) => op === 'get')[1].path, 'C:\\Usuário\\Temp\\ extracted\\app.exe');
}

// --- validação de payload no boundary do módulo.
{
  const app = fakeApp({ isPackaged: true });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  for (const bad of ['on', 1, null, undefined]) {
    const result = s.set(bad);
    assert.equal(result.ok, false, `payload inválido rejeitado: ${JSON.stringify(bad)}`);
    assert.deepEqual([result.configured, result.approved, result.enabled], [null, null, null], 'payload inválido não afirma estado');
    assert.ok(result.error);
  }
  assert.equal(app.calls.length, 0, 'payload inválido não toca o registro');
}

// --- bandeja: cada método nativo lançando na init não escapa; instância
// parcial é destruída e disponibilidade cai.
for (const [method, message] of [['setToolTip', 'tooltip quebrou'], ['setContextMenu', 'menu quebrou'], ['on', 'listener quebrou']]) {
  const partial = { destroyed: false };
  class ThrowingTray {
    constructor(icon) { this.icon = icon; }
    setToolTip() { if (method === 'setToolTip') throw new Error(message); }
    setContextMenu() { if (method === 'setContextMenu') throw new Error(message); }
    on() { if (method === 'on') throw new Error(message); }
    destroy() { partial.destroyed = true; }
  }
  const tray = createTray({ Tray: ThrowingTray, Menu: { buildFromTemplate: (template) => ({ template }) } }, {
    iconPath: path.join(here, '..', 'assets', 'icon.ico'), getHidden: () => false, toggleCrosshair() {}, restore() {}, quit() {},
  });
  assert.equal(tray.available, false, `${method} lançando desabilita a bandeja`);
  assert.match(tray.error, new RegExp(message), `${method} lançando reporta erro`);
  assert.equal(partial.destroyed, true, `${method} lançando limpa a instância parcial`);
  assert.doesNotThrow(() => { tray.refresh(); tray.destroy(); }, `${method}: refresh/destroy no-op sem throw`);
}

// --- refresh falhando APÓS o commit do store: commit de memória/disco
// permanece, nenhuma exceção escapa ao listener, fallback devolve a janela.
{
  const flakyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-tray-flaky-'));
  let restoreCalls = 0;
  let inst = null;
  class FlakyTray {
    constructor(icon) { this.icon = icon; this.menus = []; this.destroyed = false; this.n = 0; inst = this; }
    setToolTip() {}
    setContextMenu(menu) { this.n++; if (this.n > 1) throw new Error('shell sumiu'); this.menus.push(menu); }
    on() {}
    destroy() { this.destroyed = true; }
  }
  const tray = createTray({ Tray: FlakyTray, Menu: { buildFromTemplate: (template) => ({ template }) } }, {
    iconPath: path.join(here, '..', 'assets', 'icon.ico'), getHidden: () => false, toggleCrosshair() {}, quit() {},
    restore: () => { restoreCalls++; },
  });
  const store = createStore(flakyDir, { default: { id: 'default' } });
  store.onChange(() => tray.refresh());
  assert.doesNotThrow(() => store.set({ hidden: true }), 'erro do refresh não vira falha do store');
  assert.equal(store.get().hidden, true, 'commit de memória permanece');
  assert.equal(JSON.parse(fs.readFileSync(path.join(flakyDir, 'settings.json'))).hidden, true, 'commit de disco permanece');
  assert.equal(tray.available, false, 'falha de refresh derruba a disponibilidade');
  assert.equal(inst.destroyed, true, 'instância quebrada é limpa');
  assert.equal(restoreCalls, 1, 'fallback devolve acesso à janela uma vez');
  assert.doesNotThrow(() => store.set({ visible: false }), 'refresh após falha é no-op');
  assert.equal(restoreCalls, 1, 'sem loop de fallback');
  fs.rmSync(flakyDir, { recursive: true, force: true });
}

// --- restore lançando no fallback da falha runtime: não escapa do refresh,
// bandeja cai, fallback tentado uma vez (sem loop, reentrante).
{
  let restoreCalls = 0;
  class FlakyRestoreTray {
    constructor(icon) { this.icon = icon; this.n = 0; this.destroyed = false; }
    setToolTip() {}
    setContextMenu() { this.n++; if (this.n > 1) throw new Error('shell sumiu'); }
    on() {}
    destroy() { this.destroyed = true; }
  }
  const tray = createTray({ Tray: FlakyRestoreTray, Menu: { buildFromTemplate: () => ({}) } }, {
    iconPath: path.join(here, '..', 'assets', 'icon.ico'), getHidden: () => false, toggleCrosshair() {}, quit() {},
    restore: () => { restoreCalls++; throw new Error('restore falhou'); },
  });
  assert.doesNotThrow(() => tray.refresh(), 'restore falhando não escapa do refresh');
  assert.equal(tray.available, false, 'falha runtime derruba a disponibilidade');
  assert.equal(restoreCalls, 1, 'fallback tentado uma vez');
  assert.doesNotThrow(() => tray.refresh(), 'refresh reentrante pós-falha é no-op');
  assert.equal(restoreCalls, 1, 'sem loop de restore');
}

// --- refresh/destroy pós-destroy: sem chamada nativa; destroy idempotente.
{
  let menus = 0, destroys = 0;
  class StableTray {
    constructor(icon) { this.icon = icon; }
    setToolTip() {}
    setContextMenu() { menus++; }
    on() {}
    destroy() { destroys++; }
  }
  const tray = createTray({ Tray: StableTray, Menu: { buildFromTemplate: () => ({}) } }, {
    iconPath: path.join(here, '..', 'assets', 'icon.ico'), getHidden: () => false, toggleCrosshair() {}, restore() {}, quit() {},
  });
  tray.destroy();
  assert.equal(tray.available, false, 'destroy invalida a disponibilidade');
  assert.doesNotThrow(() => tray.refresh(), 'refresh pós-destroy não lança');
  assert.equal(menus, 1, 'refresh pós-destroy não toca o nativo (1 = init)');
  tray.destroy();
  assert.equal(destroys, 1, 'destroy idempotente');
  assert.equal(willMinimizeToTray({ minimizeToTray: true }, tray), false, 'bandeja destruída não esconde a janela');
}

// --- destroy nativo falhando: não escapa, invalida e não repete.
{
  let destroys = 0;
  class DyingTray {
    constructor(icon) { this.icon = icon; }
    setToolTip() {} setContextMenu() {} on() {}
    destroy() { destroys++; throw new Error('destroy falhou'); }
  }
  const tray = createTray({ Tray: DyingTray, Menu: { buildFromTemplate: () => ({}) } }, {
    iconPath: path.join(here, '..', 'assets', 'icon.ico'), getHidden: () => false, toggleCrosshair() {}, restore() {}, quit() {},
  });
  assert.doesNotThrow(() => tray.destroy(), 'destroy falhando não escapa');
  assert.equal(tray.available, false, 'destroy falho invalida a bandeja');
  assert.match(tray.error, /destroy falhou/, 'destroy falho reporta erro');
  tray.destroy();
  assert.equal(destroys, 1, 'destroy falho não repete chamada nativa');
  assert.doesNotThrow(() => tray.refresh(), 'refresh após destroy falho é no-op');
}

test('Electron 31: mock distingue comando raw truncado e comando com aspas', () => {
  for (const target of [exe, portableExe]) {
    assert.notEqual(parseCommand(target).path, target);
    assert.deepEqual(parseCommand(`"${target}"`), { path: target, args: [] });
  }
});

test('identidade Windows ignora case em name/path, mas rejeita posicional divergente visível', () => {
  for (const enabled of [true, false]) for (const name of ['OpenCrosshairQ', 'opencrosshairq']) for (const approved of [true, false]) {
    const entry = { ...ours(approved), name, path: exe.toUpperCase(), args: ['outro'] };
    const app = fakeApp({ isPackaged: true, entries: [structuredClone(entry)] });
    const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
    assert.deepEqual(app.getLoginItemSettings({ path: `"${exe}"`, args: [] }).launchItems[0].args, ['outro'], 'posicional visível');
    assert.deepEqual(s.getStatus(), { supported: true, available: true, configured: false, approved: null, enabled: approved, error: 'Conflito na entrada OpenCrosshairQ: executável ou argumentos divergentes; nada alterado.' });
    const result = s.set(enabled);
    assert.equal(result.ok, false, 'homônima divergente aborta, inclusive desligamento');
    assert.match(result.error, /conflito.*argumentos/i);
    assert.equal(result.configured, false);
    assert.equal(result.enabled, approved, 'efetivo agregado continua real');
    assert.equal(app.calls.filter(([op]) => op === 'set').length, 0, 'conflito: zero escritas');
    assert.deepEqual(app.entries, [entry]);
  }
  const app = fakeApp({ isPackaged: true, entries: [{ ...ours(true), name: 'opencrosshairq', path: exe.toUpperCase() }] });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  assert.deepEqual(s.set(true), { ok: true, configured: true, approved: true, enabled: true, error: null });
  assert.equal(app.calls.filter(([op]) => op === 'set').length, 0, 'case diferente, identidade igual: no-op válido');
  assert.equal(s.set(false).ok, true, 'remoção por nome Windows também ignora case');
  assert.equal(app.entries.length, 0);
});

test('switch de homônima não aparece em launchItems: no-op não prova comando completo', () => {
  const entry = { ...ours(true), args: ['--outro'] };
  const app = fakeApp({ isPackaged: true, entries: [structuredClone(entry)] });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  assert.deepEqual(app.getLoginItemSettings({ path: `"${exe}"`, args: [] }).launchItems[0].args, [], 'Chromium GetArgs omite switch');
  assert.deepEqual(s.getStatus(), { supported: true, available: true, configured: true, approved: true, enabled: true, error: null });
  assert.deepEqual(s.set(true), { ok: true, configured: true, approved: true, enabled: true, error: null }, 'switch invisível permite no-op');
  assert.equal(app.calls.filter(([op]) => op === 'set').length, 0);
  assert.deepEqual(app.entries, [entry], 'no-op mantém switch real; preservação em escrita não garantida');
});

test('homônima machine não é nossa; desligamento não remove entrada alheia', () => {
  const entry = { ...ours(true), args: ['--outro'], scope: 'machine' };
  const app = fakeApp({ isPackaged: true, entries: [structuredClone(entry)] });
  const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
  assert.equal(s.set(true).ok, true, 'pode criar user sem tocar machine');
  assert.equal(s.set(false).ok, false, 'machine ainda lança, falha honesta');
  assert.deepEqual(app.entries[0], entry);
  assert.deepEqual(s.getStatus(), { supported: true, available: true, configured: true, approved: true, enabled: true, error: null }, 'rollback restaura apenas nossa entrada user');
});

test('path com aspas de entrada é rejeitado antes de qualquer API, sem dupla citação', () => {
  for (const target of [`"${exe}"`, 'C:\\bad"path\\app.exe', '']) {
    const app = fakeApp({ isPackaged: true });
    const s = createStartup({ app, platform: 'win32', execPath: target, env: {} });
    assert.equal(s.set(true).ok, false);
    assert.match(s.getStatus().error, /Caminho do executável inválido/);
    assert.equal(app.calls.length, 0);
  }
});

test('rollback falho ou ignorado fica explícito e retorna estado alterado confirmado', () => {
  for (const failure of [{ failSetAt: 2 }, { ignoreSetAt: 2 }]) {
    const app = fakeApp({ isPackaged: true, failGetFrom: 1, failGetCount: 1, ...failure });
    const s = createStartup({ app, platform: 'win32', execPath: exe, env: {} });
    const result = s.set(true);
    assert.equal(result.ok, false);
    assert.deepEqual([result.configured, result.approved, result.enabled], [true, true, true]);
    assert.match(result.error, /leitura indisponível/);
    assert.match(result.error, /rollback falhou/i);
    assert.equal(app.entries.length, 1, 'escrita inicial aplicada e não revertida');
  }
});

console.log('PASS: bandeja (disponibilidade, menu, restore, destroy, minimizar condicional, métodos lançando, refresh pós-commit/destroy, destroy falho, restore falhando sem loop) + início automático (gates, name+aprovação, mesmo path/args, status real, desconhecido=null, rollback preserva par configurado+aprovação, no-op sem registro divergente, entradas alheias intactas, portable)');
