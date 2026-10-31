import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const rootDir = path.resolve('..');
const distDir = path.join(process.cwd(), 'dist');
const downloadDir = path.join(rootDir, 'download');

function sha256(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

if (!fs.existsSync(distDir)) {
  console.error('dist/ inexistente. Execute o build antes de publicar.');
  process.exit(1);
}
const files = fs.readdirSync(distDir);
const exeFiles = files.filter(f => f.endsWith('.exe') && !f.includes('builder') && fs.statSync(path.join(distDir, f)).isFile());
if (!exeFiles.length) {
  console.error('dist/ sem executáveis. Publicação cancelada; checksums preservados.');
  process.exit(1);
}
fs.mkdirSync(downloadDir, { recursive: true });

console.log('Found dist executables:', exeFiles);

const manifest = [];
for (const file of exeFiles) {
  const src = path.join(distDir, file);
  const dst = path.join(downloadDir, file);
  fs.copyFileSync(src, dst);
  const hash = sha256(dst);
  const sizeMb = (fs.statSync(dst).size / (1024 * 1024)).toFixed(2);
  manifest.push({ file, hash, sizeMb });
  console.log(`Copied ${file} (${sizeMb} MB) -> ${dst}`);
  console.log(`  SHA256: ${hash}`);
}

const checksumLines = manifest.map(m => `${m.hash}  ${m.file}`).join('\n');
fs.writeFileSync(path.join(downloadDir, 'SHA256SUMS.txt'), checksumLines + '\n', 'utf8');
console.log('SHA256SUMS.txt generated in download directory.');
