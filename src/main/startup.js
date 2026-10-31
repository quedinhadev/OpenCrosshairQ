// Início automático no login (Windows) via setLoginItemSettings/getLoginItemSettings.
// Três dimensões lidas do sistema — nunca de preferência local:
//   configured: entrada com name 'OpenCrosshairQ', escopo user, nosso path
//     Windows e args POSICIONAIS expostos pelo Electron (não comando completo);
//   approved: StartupApproved da entrada nossa (launchItems[].enabled; null
//     quando não há entrada — aprovação não se aplica);
//   enabled (efetivo): executableWillLaunchAtLogin — agregação do SO, mesmo
//     exe com QUAISQUER argumentos, só conta com run key aprovada.
// getLoginItemSettings recebe o MESMO path/args do set (requisito do Electron
// 31). Escritas usam name explícito; entradas de outros nomes/escopos
// (machine, legados sob o AUMID default) NUNCA são tocadas.
// set lê o par (configured, approved) ANTERIOR antes de escrever; estado ou
// aprovação não verificáveis => falha ANTES de escrever. Falha pós-escrita
// tenta reverter ao par ANTERIOR e verifica a restauração; rollback falho fica
// explícito. Retorno sempre traz estado real relido ou null se desconhecido.
const NAME = 'OpenCrosshairQ';

function createStartup({ app, platform = process.platform, env = process.env, execPath = process.execPath }) {
  const windows = platform === 'win32';
  const dev = !app.isPackaged;
  // Portable: registrar o .exe portátil real, nunca o executável extraído
  // temporariamente pelo launcher (process.execPath aponta para o temporário).
  const portablePath = typeof env?.PORTABLE_EXECUTABLE_FILE === 'string' && env.PORTABLE_EXECUTABLE_FILE
    ? env.PORTABLE_EXECUTABLE_FILE
    : null;
  const executable = portablePath || execPath;
  // Electron 31.7.7 browser_win.cc: FormatCommandLineString não põe aspas;
  // GetLoginItemSettingsHelper interpreta path como comando, retorna path cru.
  // https://github.com/electron/electron/blob/v31.7.7/shell/browser/browser_win.cc
  const target = () => ({ path: `"${executable}"`, args: [] });

  const gate = () => {
    if (!windows) return 'Início automático é suportado apenas no Windows.';
    if (dev) return 'Indisponível em desenvolvimento.';
    if (typeof executable !== 'string' || !executable || /["\x00-\x1f]/.test(executable)) return 'Caminho do executável inválido.';
    return null;
  };

  // Leitura canônica; lança quando o estado (ou a aprovação própria) não é
  // verificável — o chamador decide falhar ANTES de qualquer escrita.
  function read() {
    const { path, args } = target();
    const status = app.getLoginItemSettings({ path, args });
    if (!status || !Array.isArray(status.launchItems)) throw new Error('resposta do sistema incompleta');
    const named = status.launchItems.find(
      (item) => item && typeof item.name === 'string' && item.name.toLowerCase() === NAME.toLowerCase() && item.scope === 'user') ?? null;
    // Run value names e paths ignoram case no Windows; args não. launchItems
    // filtra só exe; Chromium GetArgs expõe posicionais, não switches --...
    // Homônima com divergência observável não é sobrescrita.
    const conflict = !!named && (typeof named.path !== 'string' || named.path.toLowerCase() !== executable.toLowerCase() ||
      !Array.isArray(named.args) || named.args.length !== args.length || named.args.some((arg, i) => arg !== args[i]));
    const ours = conflict ? null : named;
    if (ours && typeof ours.enabled !== 'boolean') throw new Error('aprovação não verificável');
    if (typeof status.executableWillLaunchAtLogin !== 'boolean') throw new Error('estado efetivo não verificável');
    return {
      conflict,
      configured: !!ours,
      approved: ours ? ours.enabled : null,
      effective: status.executableWillLaunchAtLogin,
    };
  }

  // enabled (StartupApproved) só faz sentido com entrada presente: null/omitido
  // com openAtLogin:false seria default true em Electron, então só enviamos
  // enabled quando openAtLogin é true.
  function write(openAtLogin, approved) {
    const { path, args } = target();
    const options = { openAtLogin, path, args, name: NAME };
    if (openAtLogin) options.enabled = approved;
    app.setLoginItemSettings(options);
  }

  const UNKNOWN = { configured: null, approved: null, enabled: null };
  const CONFLICT = 'Conflito na entrada OpenCrosshairQ: executável ou argumentos divergentes; nada alterado.';

  return {
    getStatus() {
      const blocked = gate();
      if (blocked) return { supported: windows, available: false, ...UNKNOWN, error: blocked };
      try {
        const state = read();
        return { supported: true, available: true, configured: state.configured, approved: state.approved, enabled: state.effective, error: state.conflict ? CONFLICT : null };
      } catch (error) { return { supported: true, available: true, ...UNKNOWN, error: error.message }; }
    },
    set(enabled) {
      if (typeof enabled !== 'boolean') return { ok: false, ...UNKNOWN, error: 'Valor inválido.' };
      const blocked = gate();
      if (blocked) return { ok: false, ...UNKNOWN, error: blocked };
      // Estado anterior confirmado ANTES de alterar; desconhecido => não escreve.
      let prior;
      try { prior = read(); }
      catch (error) { return { ok: false, ...UNKNOWN, error: `Estado atual indisponível: ${error.message}` }; }
      if (prior.conflict) return { ok: false, configured: prior.configured, approved: prior.approved, enabled: prior.effective, error: CONFLICT };
      // No-op somente quando o estado NOSSO já entrega o pedido — nunca pelo
      // efetivo agregado sozinho para ligar. Desligar = não iniciar AGORA;
      // entrada já não aprovada fica configurada (retorno não oculta isso).
      const done = enabled ? prior.configured && prior.approved && prior.effective : !prior.effective;
      if (done) return { ok: true, configured: prior.configured, approved: prior.approved, enabled: prior.effective, error: null };
      try {
        if (enabled) write(true, true); // ligar: entrada + aprovação
        else write(false); // desligar: remove a entrada NOSSA
        const after = read();
        const achieved = enabled ? after.configured && after.approved && after.effective : !after.effective;
        if (!achieved) throw new Error('Sistema não confirmou a alteração.');
        return { ok: true, configured: after.configured, approved: after.approved, enabled: after.effective, error: null };
      } catch (error) {
        let message = error.message;
        let rollbackFailed = false;
        try { prior.configured ? write(true, prior.approved) : write(false); }
        catch (rollbackError) { rollbackFailed = true; message += ` Rollback falhou: ${rollbackError.message}`; }
        try {
          const after = read();
          if (!rollbackFailed && (after.conflict || after.configured !== prior.configured || after.approved !== prior.approved)) message += ' Rollback falhou: sistema não confirmou a restauração.';
          return { ok: false, configured: after.configured, approved: after.approved, enabled: after.effective, error: message };
        } catch (readError) { return { ok: false, ...UNKNOWN, error: `${message} Restauração não verificável: ${readError.message}` }; }
      }
    },
  };
}

module.exports = { createStartup };
