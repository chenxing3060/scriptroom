import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 剧本工坊独立门禁密码（20 位随机，与 planvis 相互独立）。
// 明文密码不入库，注入方式二选一：
//   1) 环境变量 SCRIPTROOM_PASSWORD
//   2) tools/.password 文件（单行，已被 .gitignore 排除）
// 改密码后需重新加密全部页面与图片（encrypt-all）。
const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD_FILE = join(HERE, '.password');

function loadPassword() {
  if (process.env.SCRIPTROOM_PASSWORD) return process.env.SCRIPTROOM_PASSWORD.trim();
  if (existsSync(PASSWORD_FILE)) return readFileSync(PASSWORD_FILE, 'utf-8').trim();
  console.error('缺少门禁密码：请设置环境变量 SCRIPTROOM_PASSWORD，或创建 tools/.password（单行 20 位随机密码）');
  process.exit(1);
}

export const PASSWORD = loadPassword();
export const KEY = crypto.createHash('sha256').update(PASSWORD).digest();
export const KEY_HEX = KEY.toString('hex');

// 加密壳模板：tools/template.html（占位符 __KEY_HEX__ / __PAYLOAD__）
const TEMPLATE = join(HERE, 'template.html');

export function decryptBytes(buf) {
  const iv = buf.subarray(0, 12);
  const data = buf.subarray(12);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

export function encryptBytes(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

export function decryptHtmlPage(path) {
  const html = readFileSync(path, 'utf-8');
  const m = html.match(/var PAYLOAD = "([^"]+)"/);
  if (!m) throw new Error('PAYLOAD not found（该文件不是加密页面）: ' + path);
  return decryptBytes(Buffer.from(m[1], 'base64')).toString('utf-8');
}

export function buildEncryptedPage(plainHtml) {
  const tpl = readFileSync(TEMPLATE, 'utf-8');
  const payload = encryptBytes(Buffer.from(plainHtml, 'utf-8')).toString('base64');
  return tpl
    .replace('__KEY_HEX__', KEY_HEX)
    .replace('__PAYLOAD__', payload);
}
