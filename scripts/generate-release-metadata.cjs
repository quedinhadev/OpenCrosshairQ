const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
async function generateReleaseMetadata({ distDir, version }) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid release version');
  const portable = 'OpenCrosshairQ-Portable.exe';
  const files = [portable, `OpenCrosshairQ-Setup-${version}.exe`, `OpenCrosshairQ-Setup-${version}.exe.blockmap`, 'latest.yml'];
  for (const name of files) {
    const stat = fs.lstatSync(path.join(distDir, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Missing or invalid artifact: ${name}`);
  }
  const latest = fs.readFileSync(path.join(distDir, 'latest.yml'), 'utf8');
  if (!latest.split(/\r?\n/).some(line => line === `version: ${version}`)) throw new Error('latest.yml version mismatch');
  const manifest = { schemaVersion: 1, version, file: portable, size: fs.statSync(path.join(distDir, portable)).size, sha256: await hashFile(path.join(distDir, portable)) };
  atomicWrite(path.join(distDir, 'portable-update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  files.push('portable-update.json');
  files.sort();
  const sums = [];
  for (const file of files) sums.push(`${await hashFile(path.join(distDir, file))}  ${file}`);
  atomicWrite(path.join(distDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  return { files, manifest };
}
if (require.main === module) {
  const version = require('../package.json').version;
  generateReleaseMetadata({ distDir: path.join(__dirname, '..', 'dist'), version })
    .then(({ files }) => console.log(`Release metadata generated: ${files.length} artifacts, version ${version}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { generateReleaseMetadata };
