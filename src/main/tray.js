// Bandeja (tray): ícone + menu abrir/exibir-ocultar mira/sair, restauração por
// clique. Disponibilidade é real — Tray/ícone legível ou nada; minimizar segue
// o comportamento normal quando a bandeja não existe. Toda a init é contenida:
// falha em qualquer método nativo limpa a instância parcial e derruba a
// disponibilidade. refresh/destroy são idempotentes e nunca lançam — o listener
// do store dispara refresh DEPOIS do commit, então erro aqui não pode virar
// falha do store. Falha runtime invalida antes de tocar o nativo e devolve
// acesso à janela (fallback de restauração), sem loop.
const fs = require('fs');

// Minimizar só esconde a janela com a preferência ligada E bandeja funcional.
function willMinimizeToTray(prefs, tray) {
  return prefs?.minimizeToTray === true && tray?.available === true;
}

function createTray({ Tray, Menu }, { iconPath, tooltip = 'OpenCrosshairQ', getHidden, toggleCrosshair, restore, quit }) {
  const unavailable = (error) => ({ available: false, error, refresh() { return false; }, destroy() {} });
  if (!Tray || !Menu) return unavailable('API de bandeja ausente');
  if (typeof iconPath !== 'string' || !fs.existsSync(iconPath)) return unavailable('ícone da bandeja ausente');

  let tray = null;
  let dead = false;
  let error = null;

  const show = () => {
    try { restore?.(); }
    catch (e) { console.error('[tray restore]', e.message); }
  };

  // Falha: invalida a disponibilidade ANTES do destroy, limpa a instância
  // parcial e (em falha runtime) devolve acesso à janela escondida.
  function fail(message, { fallback = true } = {}) {
    error = message;
    console.error('[tray]', message);
    dead = true; // disponibilidade cai antes de qualquer chamada nativa
    const partial = tray;
    tray = null;
    if (partial) { try { partial.destroy(); } catch { /* já removida */ } }
    if (fallback) show();
  }

  const buildMenu = () => Menu.buildFromTemplate([
    { label: 'Abrir OpenCrosshairQ', click: show },
    { type: 'separator' },
    { label: getHidden?.() ? 'Exibir mira' : 'Ocultar mira', click: () => toggleCrosshair?.() },
    { type: 'separator' },
    { label: 'Sair', click: () => quit?.() },
  ]);

  // Init inteira contida: construtor, tooltip, menu e listeners.
  try {
    tray = new Tray(iconPath);
    tray.setToolTip(tooltip);
    tray.setContextMenu(buildMenu());
    tray.on('click', show);
    tray.on('double-click', show);
  } catch (e) {
    fail(e.message, { fallback: false }); // na init a janela não foi escondida
  }

  return {
    get available() { return !dead; },
    get error() { return error; },
    // Idempotente e seguro: após destroy/falha é no-op, sem chamada nativa e
    // sem lançar (commit do store já aconteceu; rejeição aqui seria falsa).
    refresh() {
      if (dead || !tray) return false;
      try {
        tray.setContextMenu(buildMenu());
        return true;
      } catch (e) { fail(e.message); return false; }
    },
    // Idempotente: disponibilidade invalidada ANTES do destroy nativo; falha
    // do destroy não escapa e não repete.
    destroy() {
      if (dead) return;
      dead = true; // disponibilidade cai antes do destroy
      const native = tray;
      tray = null;
      if (native) {
        try { native.destroy(); }
        catch (e) { error = e.message; console.error('[tray destroy]', e.message); }
      }
    },
  };
}

module.exports = { createTray, willMinimizeToTray };
