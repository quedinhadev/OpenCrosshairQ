// Cleanroom state rules; static references: analysis/continuation-game-state-report.md.
// No proprietary game catalog. Native path unavailability preserves profile state.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CQGameState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function evaluateForeground(previous, processPath, profiles, options = {}) {
    if (options.suspended || typeof processPath !== 'string' || !processPath || /(?:^|[\\/])explorer\.exe$/i.test(processPath)) return previous;
    if (options.autoSwitch !== false) {
      const match = Object.values(profiles)
        .filter(profile => profile.process?.path === processPath)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
      if (match && match.id !== previous.profileId) return { profileId: match.id, profileInFocus: true };
    }
    const current = profiles[previous.profileId];
    return {
      profileId: previous.profileId,
      profileInFocus: !current?.process?.path || !current.hideCrosshairWhenUnfocused || current.process.path === processPath,
    };
  }
  function isCrosshairVisible(state) {
    if (state.hidden || !state.visible) return false;
    if (state.designerPreview) return true;
    return state.profileInFocus !== false && (!state.onlyInGame || state.gameInFocus === true);
  }
  return { evaluateForeground, isCrosshairVisible };
});
