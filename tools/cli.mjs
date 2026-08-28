#!/usr/bin/env node
// 用法：
//   node cli.mjs decrypt site/script-xxx.html              # 解密页面 → 输出明文
//   node cli.mjs encrypt source/xxx.html site/xxx.html     # 加密明文 → 写入目标
//   node cli.mjs encrypt-img source/a.jpg site/a.jpg.enc   # 加密图片
//   node cli.mjs decrypt-img site/a.jpg.enc                # 解密图片 → 输出
//   node cli.mjs key                                        # 打印当前 KEY_HEX
//   node cli.mjs encrypt-all                                # 加密 source/ 全部页面到 site/
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { decryptHtmlPage, buildEncryptedPage, encryptBytes, decryptBytes, KEY_HEX } from './crypto.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(ROOT, 'source');
const DST = join(ROOT, 'site');
const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'key') { console.log('KEY_HEX =', KEY_HEX); process.exit(0); }

switch (cmd) {
  case 'decrypt':
    process.stdout.write(decryptHtmlPage(a)); break;
  case 'encrypt':
    writeFileSync(b, buildEncryptedPage(readFileSync(a, 'utf-8')), 'utf-8');
    console.log('✓ encrypted →', b); break;
  case 'encrypt-img':
    writeFileSync(b, encryptBytes(readFileSync(a)), 'utf-8');
    console.log('✓ encrypted →', b); break;
  case 'decrypt-img':
    process.stdout.write(decryptBytes(readFileSync(a))); break;
  case 'encrypt-all': {
    const pages = readdirSync(SRC).filter(f => f.endsWith('.html'));
    for (const p of pages) {
      writeFileSync(join(DST, p), buildEncryptedPage(readFileSync(join(SRC, p), 'utf-8')), 'utf-8');
      console.log('✓ encrypted →', join(DST, p));
    }
    // 明文样式与脚本原样同步到 site/，防止 source 更新后 site 仍是旧版
    for (const sub of ['css', 'js']) {
      const dir = join(SRC, 'assets', sub);
      mkdirSync(join(DST, 'assets', sub), { recursive: true });
      for (const f of readdirSync(dir).filter(f => /\.(css|js)$/.test(f))) {
        writeFileSync(join(DST, 'assets', sub, f), readFileSync(join(dir, f)));
        console.log('✓ synced →', join(DST, 'assets', sub, f));
      }
    }
    const assetDir = join(SRC, 'assets', 'scripts');
    for (const d of readdirSync(assetDir)) {
      const dir = join(assetDir, d);
      for (const f of readdirSync(dir).filter(f => /\.(jpg|png)$/.test(f))) {
        const out = join(DST, 'assets', 'scripts', d, f + '.enc');
        mkdirSync(join(DST, 'assets', 'scripts', d), { recursive: true });
        writeFileSync(out, encryptBytes(readFileSync(join(dir, f))), 'utf-8');
        console.log('✓ encrypted →', out);
      }
    }
    break;
  }
  default:
    console.error(cmd ? '未知命令: ' + cmd : '缺少参数，见文件头注释'); process.exit(1);
}
