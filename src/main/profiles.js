// Perfis — JSON por perfil em <userData>\profiles, espelhando o original.
// Dual export (main CJS / tests).
const fs = require('fs');
const path = require('path');

function profileDir(userDataDir) {
  const dir = path.join(userDataDir, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
}

function loadProfiles(userDataDir) {
  const dir = profileDir(userDataDir);
  const profiles = {};
  let files = [];
  try { files = fs.readdirSync(dir); } catch { /* first run */ }

  // 1. Process valid committed .json files
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (p && validId(p.id) && f === `${p.id}.json` && p.settings && typeof p.settings === 'object' && !Array.isArray(p.settings)) {
        profiles[p.id] = p;
      }
    } catch { /* skip corrupt */ }
  }

  // 2. BACK-6: Process orphan .tmp files (recover uncommitted write if valid and missing, or remove stale)
  for (const f of files) {
    if (!f.endsWith('.json.tmp')) continue;
    const baseId = f.slice(0, -9);
    if (!validId(baseId)) continue;
    const tmpPath = path.join(dir, f);
    const targetPath = path.join(dir, `${baseId}.json`);

    if (profiles[baseId]) {
      // Valid profile exists; tmp is stale artifact
      try { fs.unlinkSync(tmpPath); } catch {}
    } else {
      // Target profile was missing or corrupt; attempt recovery from tmp
      try {
        const candidate = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
        if (candidate && candidate.id === baseId && candidate.settings && typeof candidate.settings === 'object' && !Array.isArray(candidate.settings)) {
          console.warn(`[profiles] recovering orphan .tmp for ${baseId}`);
          try {
            fs.renameSync(tmpPath, targetPath);
          } catch {
            fs.copyFileSync(tmpPath, targetPath);
            try { fs.unlinkSync(tmpPath); } catch {}
          }
          profiles[baseId] = candidate;
        } else {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } catch {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
  }

  return { profiles };
}

function saveProfile(userDataDir, p) {
  if (!validId(p?.id)) throw new TypeError('Invalid profile ID');
  const file = path.join(profileDir(userDataDir), `${p.id}.json`);
  const temporary = `${file}.tmp`;
  // Small profile writes are synchronous to preserve order and surface failures.
  fs.writeFileSync(temporary, JSON.stringify(p, null, 2));
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    // Commit acknowledged as failed: remove the orphan tmp so loadProfiles
    // recovery cannot resurrect a rejected write. Crash recovery is unaffected
    // (a killed process never reaches this catch).
    try { fs.unlinkSync(temporary); } catch { /* nothing to clean */ }
    console.error(`[profiles] atomic rename failed for ${p.id}: ${error.message}`);
    throw error;
  }
}

function deleteProfileFile(userDataDir, id) {
  if (!validId(id)) throw new TypeError('Invalid profile ID');
  const target = path.join(profileDir(userDataDir), `${id}.json`);
  const tmp = `${target}.tmp`;
  try { fs.unlinkSync(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.unlinkSync(tmp); } catch {}
}

function configureProfile(profiles, options) {
  if (!options || typeof options !== 'object' || !validId(options.id) || !Object.hasOwn(profiles, options.id)) throw new TypeError('Invalid profile ID');
  if (options.id === 'default') throw new Error('Default profile cannot bind a process');
  const { processPath, hideCrosshairWhenUnfocused } = options;
  if (typeof hideCrosshairWhenUnfocused !== 'boolean') throw new TypeError('hideCrosshairWhenUnfocused must be boolean');
  // ponytail: local drive paths only; add explicit UNC policy before network paths.
  // Segments may contain spaces ("C:\Program Files\Game\game.exe"); Windows only
  // forbids empty segments and trailing space/dot per segment.
  const validProcessPath = typeof processPath === 'string' && processPath.length <= 32767
    && /^[a-zA-Z]:\\[^<>:"|?*\0-\u001f]+\.exe$/i.test(processPath)
    && processPath.slice(3, -4).split('\\').every((segment) => segment.length > 0 && !/[. ]$/.test(segment) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment));
  if (processPath !== null && !validProcessPath) throw new TypeError('Invalid executable path');
  if (processPath !== null && Object.values(profiles).some(p => p.id !== options.id && p.process?.path === processPath)) throw new Error('Process path already assigned');
  return {
    ...profiles[options.id],
    process: processPath === null ? null : { path: processPath, name: path.win32.basename(processPath) },
    hideCrosshairWhenUnfocused: processPath !== null && hideCrosshairWhenUnfocused,
  };
}

module.exports = { profileDir, loadProfiles, saveProfile, deleteProfileFile, configureProfile };
