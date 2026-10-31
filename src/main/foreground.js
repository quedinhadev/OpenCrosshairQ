// Polling is our own implementation choice, not the original event-hook cadence.
function createForegroundMonitor(provider, onChange, loadError = null) {
  let timer = null;
  let status = { available: typeof provider?.getForegroundProcess === 'function', foreground: null, error: loadError };
  function poll() {
    if (!status.available) return;
    let next;
    try { next = { available: true, foreground: provider.getForegroundProcess(), error: null }; }
    catch (error) { next = { available: true, foreground: null, error: error.message }; }
    if (JSON.stringify(next) !== JSON.stringify(status)) {
      status = next;
      onChange(status);
    }
  }
  return {
    poll,
    getStatus: () => structuredClone(status),
    start() { if (!timer && status.available) { poll(); timer = setInterval(poll, 250); timer.unref(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
module.exports = { createForegroundMonitor };
