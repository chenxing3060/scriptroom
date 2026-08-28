// 本地模拟 EdgeOne 边缘函数运行时的最小测试：内存 KV + Web Request/Response
// 用法：node tools/test-functions.mjs

import { pathToFileURL } from 'node:url';

const kvData = new Map();
globalThis.SUBMISSIONS_KV = {
  async get(key) { return kvData.has(key) ? kvData.get(key) : null; },
  async put(key, value) { kvData.set(key, String(value)); },
  async delete(key) { kvData.delete(key); },
  async list({ prefix = '', limit = 256, cursor } = {}) {
    const keys = [...kvData.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((key) => ({ key }));
    return { complete: true, cursor: null, keys };
  },
};

const env = { ADMIN_TOKEN: 'test-admin-token', FEISHU_WEBHOOK: '' };
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

function post(body) {
  return new Request(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function get(id, token) {
  const h = token ? { Authorization: 'Bearer ' + token } : {};
  return new Request(BASE + (id ? '/' + id : ''), { method: 'GET', headers: h });
}
function patch(id, token, body) {
  return new Request(BASE + '/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
}

const valid = {
  title: 'Blood Moon Bride',
  idea: 'Sold by her stepmother to settle a debt, a girl discovers her new Alpha husband is the boy who saved her from the fire ten years ago.',
  pairing: 'bg', category: 'fated-mates', episodes: '72',
  benchmark: 'Fated to My Forbidden Alpha', contact: 'wx: demo',
};

console.log('① POST 合法提交');
let r = await indexMod.onRequest({ request: post(valid), env, waitUntil });
let j = await r.json();
check('返回 200', r.status === 200, 'status=' + r.status);
check('ok=true', j.ok === true);
check('编号格式合法', /^SR_\d{8}_[A-Za-z0-9]{8}$/.test(j.id), JSON.stringify(j.id));
check('初始状态已接收', j.statusLabel === '已接收');
const ID = j.id;

console.log('② POST 非法字段');
r = await indexMod.onRequest({ request: post({ ...valid, pairing: 'xx' }), env, waitUntil });
j = await r.json();
check('非法配向 → 400', r.status === 400 && j.error === 'BAD_PAIRING');
r = await indexMod.onRequest({ request: post({ ...valid, category: 'nope' }), env, waitUntil });
check('非法母题 → 400', r.status === 400);
r = await indexMod.onRequest({ request: post({ ...valid, episodes: '99' }), env, waitUntil });
check('非法集数 → 400', r.status === 400);
r = await indexMod.onRequest({ request: post({ title: '', idea: 'x', pairing: 'bg', category: 'mafia', episodes: '60' }), env, waitUntil });
check('缺剧名 → 400 MISSING_FIELDS', r.status === 400 && (await r.json()).error === 'MISSING_FIELDS');
r = await indexMod.onRequest({ request: new Request(BASE, { method: 'POST', body: 'not-json' }), env, waitUntil });
check('非 JSON → 400 BAD_JSON', r.status === 400 && (await r.json()).error === 'BAD_JSON');
r = await indexMod.onRequest({ request: post({ ...valid, title: 'x'.repeat(300) }), env, waitUntil });
check('超长剧名被截断到 100', r.status === 200);

console.log('③ GET 列表（鉴权）');
r = await indexMod.onRequest({ request: get(null, null), env });
check('无 token → 401', r.status === 401);
r = await indexMod.onRequest({ request: get(null, 'wrong'), env });
check('错 token → 401', r.status === 401);
r = await indexMod.onRequest({ request: get(null, 'test-admin-token'), env });
j = await r.json();
check('正确 token → 200 且包含记录', r.status === 200 && j.count >= 1);
check('记录含全部字段', j.submissions[0] && j.submissions[0].id && j.submissions[0].title && j.submissions[0].pairing);

console.log('④ GET /:id 状态查询');
r = await idMod.onRequest({ request: get(ID, null), env, params: { id: ID } });
j = await r.json();
check('公开查询 → 200', r.status === 200 && j.ok);
check('返回状态与标题', j.status === 'received' && j.title === 'Blood Moon Bride');
check('公开查询不含联系方式', !('contact' in j));
r = await idMod.onRequest({ request: get('SR_20260801_AAAAAAAA', null), env, params: { id: 'SR_20260801_AAAAAAAA' } });
check('不存在编号 → 404', r.status === 404);
r = await idMod.onRequest({ request: get('../etc', null), env, params: { id: '../etc' } });
check('非法编号格式 → 400', r.status === 400);
r = await idMod.onRequest({ request: get(ID, 'test-admin-token'), env, params: { id: ID } });
j = await r.json();
check('管理员查询返回完整记录（含 contact）', j.submission && j.submission.contact === 'wx: demo');

console.log('⑤ PATCH 审核流转');
r = await idMod.onRequest({ request: patch(ID, null, { status: 'reviewing' }), env, params: { id: ID } });
check('无 token PATCH → 401', r.status === 401);
r = await idMod.onRequest({ request: patch(ID, 'test-admin-token', { status: 'bad-status' }), env, params: { id: ID } });
check('非法状态 → 400', r.status === 400);
r = await idMod.onRequest({ request: patch(ID, 'test-admin-token', { status: 'generating', note: '进入 Kimi K3 撰写管线' }), env, params: { id: ID } });
j = await r.json();
check('状态更新成功', r.status === 200 && j.status === 'generating' && j.statusLabel === '撰写管线中');
r = await idMod.onRequest({ request: get(ID, null), env, params: { id: ID } });
j = await r.json();
check('公开查询反映新状态与备注', j.status === 'generating' && j.statusNote === '进入 Kimi K3 撰写管线');

console.log('⑥ 其他方法与 KV 未绑定');
r = await indexMod.onRequest({ request: new Request(BASE, { method: 'DELETE' }), env });
check('DELETE /api/submissions → 405', r.status === 405);
const saved = globalThis.SUBMISSIONS_KV;
globalThis.SUBMISSIONS_KV = undefined;
r = await indexMod.onRequest({ request: post(valid), env, waitUntil });
check('KV 未绑定 → 503 KV_UNBOUND', r.status === 503 && (await r.json()).error === 'KV_UNBOUND');
globalThis.SUBMISSIONS_KV = saved;

await Promise.allSettled(pending);
console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
