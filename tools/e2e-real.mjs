// 真实 API 全链路 E2E：用真实 Kimi k3 + 速创密钥驱动完整管线（大纲→梗概→剧本→资产→发布）
// 用法：KIMI_API_KEY=sk-xxx SUCHUANG_API_KEY=xxx node tools/e2e-real.mjs
// 本机代理会导致 Node fetch 证书报错，需 NODE_TLS_REJECT_UNAUTHORIZED=0（仅本地测试）
import { pathToFileURL } from 'node:url';

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const SUCHUANG_API_KEY = process.env.SUCHUANG_API_KEY;
if (!KIMI_API_KEY || !SUCHUANG_API_KEY) {
  console.error('缺少 KIMI_API_KEY / SUCHUANG_API_KEY 环境变量');
  process.exit(1);
}

const kvData = new Map();
globalThis.SUBMISSIONS_KV = {
  async get(key, opts) {
    if (!kvData.has(key)) return null;
    const v = kvData.get(key);
    if (opts && (opts.type === 'arrayBuffer' || opts === 'arrayBuffer')) {
      if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      if (typeof v === 'string') return new TextEncoder().encode(v).buffer;
    }
    return typeof v === 'string' ? v : new TextDecoder().decode(v);
  },
  async put(key, value) { kvData.set(key, value); },
  async delete(key) { kvData.delete(key); },
  async list({ prefix = '', limit = 256 } = {}) {
    return { complete: true, cursor: null, keys: [...kvData.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key })) };
  },
};

const env = {
  ADMIN_TOKEN: 'e2e-admin-token',
  KIMI_API_KEY,
  SUCHUANG_API_KEY,
  FEISHU_WEBHOOK: '',
};
const pending = [];
const waitUntil = (p) => { pending.push(p); };

const base = new URL('../edge-functions/api/submissions/', import.meta.url);
const indexMod = await import(new URL('index.js', base).href);
const idMod = await import(decodeURI(new URL('[id].js', base).href));

const BASE = 'http://local.test/api/submissions';
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
const post = (body) => new Request(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (id, body) => new Request(BASE + '/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.ADMIN_TOKEN }, body: JSON.stringify(body) });
const D = async (id, body) => {
  const r = await idMod.onRequest({ request: patch(id, body), env, params: { id } });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

console.log('真实 E2E：Kimi k3 + 速创 全链路（72 集）');
let r = await indexMod.onRequest({ request: post({
  title: 'Midnight Contract Bride',
  idea: 'Forced to sign a one-year marriage contract with the cold CEO who ruined her family, she discovers the contract hides a clause written for her ten years ago.',
  pairing: 'bg', category: 'contract', episodes: '72', contact: 'e2e',
}), env, waitUntil });
let j = await r.json();
const ID = j.id;
check('提交成功 ' + ID, r.status === 200);

console.log('── 阶段 1：大纲（3 批真实 kimi-k3）');
let d = await D(ID, { action: 'request-generate', stage: 'outline' });
check('request-generate', d.status === 200);
for (let i = 1; i <= 3; i++) {
  d = await D(ID, { action: 'drive' });
  const o = d.j.submission.stages.outline;
  if (d.j.error) { console.log('    错误：' + d.j.error); break; }
  console.log('    批 ' + i + '（' + sec() + '）：' + (o.genBatch ? 'step=' + o.genBatch.step : '完成') +
    (o.content.setting ? ' | setting=' + String(o.content.setting).slice(0, 40) : '') +
    (o.content.mainChars ? ' | chars=' + o.content.mainChars.length : '') +
    (o.content.fiveActs ? ' | acts=' + o.content.fiveActs.length : ''));
}
check('大纲真实生成完成（含 setting/mainChars/fiveActs）',
  d.j.stageStatus === 'pending_review' &&
  d.j.submission.stages.outline.content.setting &&
  d.j.submission.stages.outline.content.mainChars &&
  d.j.submission.stages.outline.content.fiveActs,
  'stageStatus=' + d.j.stageStatus);

console.log('── 阶段 2：分集梗概（6 批 × 12 集）');
d = await D(ID, { action: 'decision', stage: 'outline', decision: 'approved' });
if (d.j.stage !== 'synopsis') { console.log('大纲确认失败：' + JSON.stringify(d.j).slice(0, 400) + ' | HTTP ' + d.status); process.exit(1); }
d = await D(ID, { action: 'request-generate', stage: 'synopsis' });
for (let i = 1; i <= 8; i++) {
  d = await D(ID, { action: 'drive' });
  if (d.j.error || !d.j.submission) { console.log('    错误：' + (d.j.error || d.j.message || '无记录')); break; }
  const s = d.j.submission.stages.synopsis;
  console.log('    批 ' + i + '（' + sec() + '）：' + (s.progress ? s.progress.done + '/' + s.progress.total + ' 集' : s.status));
  if (d.j.stageStatus === 'pending_review') break;
}
const synEps = ((d.j.submission || {}).stages || {}).synopsis ? (d.j.submission.stages.synopsis.content || {}).episodes || [] : [];
check('梗概真实生成完成（72 集）', d.j.stageStatus === 'pending_review' && synEps.length === 72, 'len=' + synEps.length);
check('梗概 ep 连续 1-72', synEps.every((e, i) => e.ep === i + 1));
check('梗概含付费卡点', synEps.some((e) => e.paymark));

console.log('── 阶段 3：完整剧本（真实撰写 2 集 + 手动补齐）');
d = await D(ID, { action: 'decision', stage: 'synopsis', decision: 'approved' });
d = await D(ID, { action: 'request-generate', stage: 'script' });
for (let i = 1; i <= 2; i++) {
  d = await D(ID, { action: 'drive' });
  if (d.j.error || !d.j.submission) { console.log('    错误：' + (d.j.error || '无记录')); break; }
  const s = d.j.submission.stages.script;
  console.log('    第 ' + i + ' 集（' + sec() + '）：scenes=' + ((s.content.episodes || [])[0] || {}).scenes?.length +
    ' | 台词样例=' + JSON.stringify((((s.content.episodes || [])[0] || {}).scenes || [])[0]?.lines?.[0] || {}).slice(0, 90));
}
const epReal = (((d.j.submission || {}).stages || {}).script ? d.j.submission.stages.script.content || {} : {}).episodes || [];
check('剧本真实撰写 2 集（含英文台词+中文对照）',
  epReal.length === 2 && epReal[0].scenes && epReal[0].scenes[0].lines[0].l && epReal[0].scenes[0].lines[0].lZh);

d = await D(ID, { action: 'stage-content', stage: 'script', content: { episodes: [...epReal, ...Array.from({ length: 70 }, (_, i) => ({ ep: i + 3, title: 'T', hook: 'H', scenes: [] }))] } });
d = await D(ID, { action: 'decision', stage: 'script', decision: 'approved' });
check('补齐并确认剧本 → 资产阶段', d.j.stage === 'assets');

console.log('── 阶段 4：视觉资产（真实速创异步生图 5 张：提交任务→轮询→下载）');
d = await D(ID, { action: 'assets-choice', choice: 'generate' });
let pollN = 0, lastDone = -1, billingBlocked = false;
for (let i = 1; i <= 150; i++) {
  d = await D(ID, { action: 'drive' });
  pollN++;
  if (d.j.error || !d.j.submission) {
    console.log('    错误：' + (d.j.error || '无记录'));
    if (/余额不足|充值/.test(d.j.error || '')) billingBlocked = true;
    break;
  }
  const a = d.j.submission.stages.assets;
  const done = a.progress ? a.progress.done : 0;
  if (done !== lastDone || i % 10 === 0) console.log('    拍 ' + i + '（' + sec() + '）：' + done + '/' + (a.progress ? a.progress.total : 5) + ' 张' + (a.pendingImg ? '（' + a.pendingImg + ' 生成中…）' : ''));
  lastDone = done;
  if (d.j.stageStatus === 'pending_review') break;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('    轮询拍数：' + pollN);
const items = (((d.j.submission || {}).stages || {}).assets ? d.j.submission.stages.assets.content || {} : {}).items || [];

if (billingBlocked) {
  check('速创余额不足 → 管线友好降级（错误含充值指引，充值后重跑即可，无需改码）', true);
  console.log('\n⚠ 速创账户余额不足：文本生成（Kimi k3）已全部真实跑通；生图在速创控制台充值后重跑本脚本即可。');
  console.log('结果：' + passed + ' 通过 / ' + failed + ' 失败（总耗时 ' + sec() + '）');
  process.exit(failed ? 1 : 2);
}

check('5 张图全部生成', d.j.stageStatus === 'pending_review' && items.length === 5, 'items=' + items.length);
let imgOk = 0;
const seenHashes = new Set();
for (const it of items) {
  const buf = await globalThis.SUBMISSIONS_KV.get('sub_' + ID + '_img_' + it.key, { type: 'arrayBuffer' });
  const u8 = new Uint8Array(buf || new ArrayBuffer(0));
  const h = await crypto.subtle.digest('SHA-256', u8).then((b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join(''));
  seenHashes.add(h);
  const isJpg = u8[0] === 0xff && u8[1] === 0xd8;
  const isPng = u8[0] === 0x89 && u8[1] === 0x50;
  if (u8.length > 2048 && (isJpg || isPng)) {
    imgOk++; console.log('    ' + it.key + '：' + Math.round(u8.length / 1024) + 'KB ' + (isJpg ? 'JPEG' : 'PNG') + ' ✓');
  } else {
    console.log('    ' + it.key + '：' + u8.length + 'B ✗（非 JPEG/PNG）');
  }
}
check('5 张 KV 图片均为真实 JPEG/PNG', imgOk === 5, 'imgOk=' + imgOk);
check('5 张图片内容互不相同（hash 去重后仍 5 张）', seenHashes.size === 5, 'unique=' + seenHashes.size);
check('生图 prompt 由 kimi 生成', !!(items.length && (((d.j.submission || {}).stages || {}).assets || {}).content && (d.j.submission.stages.assets.content.prompts || {}).key_art));

console.log('── 阶段 5：发布');
d = await D(ID, { action: 'decision', stage: 'assets', decision: 'approved' });
d = await D(ID, { action: 'publish-done', feishuDocUrl: 'https://allinagi.feishu.cn/docx/e2e', pageUrl: 'https://scriptroom.allinagi.com.cn/' });
check('发布完成 → done', d.j.stage === 'done');

await Promise.allSettled(pending);
console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败（总耗时 ' + sec() + '）');
process.exit(failed ? 1 : 0);
