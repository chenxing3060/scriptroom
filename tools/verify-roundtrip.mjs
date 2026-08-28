// 解密往返校验：site/ 密文 → 明文 与 source/ 逐字节比对
import { readFileSync } from 'fs';
import { decryptHtmlPage, decryptBytes } from './crypto.mjs';

const pages = ['index', 'pipeline', 'script-new', 'scripts', 'script-blood-moon-bride'];
let fail = 0;
for (const p of pages) {
  const dec = decryptHtmlPage(`site/${p}.html`);
  const src = readFileSync(`source/${p}.html`, 'utf-8');
  const ok = dec === src;
  if (!ok) fail++;
  console.log(`${p}.html ${ok ? 'MATCH' : 'MISMATCH'}`);
}

const jsFiles = ['pipeline.js', 'script-detail.js', 'scripts-list.js'];
for (const f of jsFiles) {
  const a = readFileSync(`source/assets/js/${f}`);
  const b = readFileSync(`site/assets/js/${f}`);
  const ok = a.equals(b);
  if (!ok) fail++;
  console.log(`assets/js/${f} ${ok ? 'MATCH' : 'MISMATCH'}`);
}

const imgs = [
  'char_alina', 'char_kane', 'cover_bloodmoon', 'plot_wedding', 'scene_packhouse',
];
for (const n of imgs) {
  const src = readFileSync(`source/assets/scripts/blood-moon-bride/${n}.jpg`);
  const dec = decryptBytes(readFileSync(`site/assets/scripts/blood-moon-bride/${n}.jpg.enc`));
  const ok = src.equals(dec);
  if (!ok) fail++;
  console.log(`${n}.jpg.enc ${ok ? 'MATCH' : 'MISMATCH'}`);
}

console.log(fail === 0 ? '\n全部往返校验通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
