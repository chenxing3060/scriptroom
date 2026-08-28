// 本地模拟 EdgeOne 边缘函数运行时的最小测试：内存 KV + Web Request/Response
// 用法：node tools/test-functions.mjs

import { pathToFileURL } from 'node:url';

const kvData = new Map();
globalThis.SUBMISSIONS_KV = {
  async get(key, opts) {
    if (!kvData.has(key)) return null;
    const v = kvData.get(key);
    if (opts && (opts.type === 'arrayBuffer' || opts === 'arrayBuffer')) {
      if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      if (typeof v === 'string') return new TextEncoder().encode(v).buffer;
      if (v instanceof ArrayBuffer) return v;
    }
    return typeof v === 'string' ? v : (v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v));
  },
  async put(key, value) { kvData.set(key, value); },
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
check('返回 16 位编辑密钥', /^[A-Za-z0-9]{16}$/.test(j.editKey || ''), JSON.stringify(j.editKey));
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

console.log('⑥ 管线：大纲阶段');
const P = (id, body) => idMod.onRequest({ request: patch(id, 'test-admin-token', body), env, params: { id } });
r = await indexMod.onRequest({ request: post({ ...valid, title: 'Pipeline Test One' }), env, waitUntil });
const ID2 = (await r.json()).id;
r = await P(ID2, { action: 'stage-content', stage: 'bogus' });
check('非法阶段名 → 400 BAD_STAGE', r.status === 400 && (await r.json()).error === 'BAD_STAGE');
r = await P(ID2, {
  action: 'stage-content', stage: 'outline',
  content: {
    logline: 'A jungle heir meets a dark prince.',
    loglineZh: '丛林继承人与黑暗王子。',
    genreTags: ['亿万总裁', '契约婚姻'],
    setting: 'New York / rainforest flashbacks',
    themes: 'power vs wildness',
    cpDynamics: 'enemies to lovers',
    paywallStrategy: '6 walls',
    mainChars: [{ name: 'Tarzan', nameZh: '泰山', role: '主角', arc: 'wild → tamed power' }],
    fiveActs: [{ act: 1, title: '婚约枷锁', epRange: 'EP01-12', summary: '被卖抵债' }],
  },
});
j = await r.json();
check('大纲写入 → 200 pending_review', r.status === 200 && j.stageStatus === 'pending_review');
r = await idMod.onRequest({ request: get(ID2, null), env, params: { id: ID2 } });
j = await r.json();
check('公开查询含阶段摘要（大纲·待确认）', j.stageLabel === '大纲' && j.stageStatusLabel === '待确认');
check('首次写入同步 status=generating', j.status === 'generating');
r = await P(ID2, { action: 'decision', stage: 'outline', decision: 'approved' });
j = await r.json();
check('通过大纲 → 推进到分集梗概', r.status === 200 && j.stage === 'synopsis' && j.stageLabel === '分集梗概');
r = await P(ID2, { action: 'decision', stage: 'outline', decision: 'approved' });
check('对非当前阶段确认 → 400 STAGE_NOT_ACTIVE', r.status === 400 && (await r.json()).error === 'STAGE_NOT_ACTIVE');
r = await P(ID2, { action: 'stage-content', stage: 'outline', content: { logline: 'overwrite' } });
check('对已通过阶段写入 → 409 STAGE_LOCKED', r.status === 409 && (await r.json()).error === 'STAGE_LOCKED');

console.log('⑦ 管线：分集梗概（驳回反馈 → 重生成 → 通过）');
r = await P(ID2, {
  action: 'stage-content', stage: 'synopsis',
  content: { episodes: [
    { ep: 1, title: 'The Debt', hook: 'She signs', beat: 'beat 1', paymark: '' },
    { ep: 2, title: 'Cold Welcome', hook: 'The slap', beat: 'beat 2', paymark: '💎 付费墙①' },
  ] },
});
j = await r.json();
check('梗概写入 → pending_review', j.stageStatus === 'pending_review');
r = await P(ID2, { action: 'decision', stage: 'synopsis', decision: 'rejected' });
check('驳回无反馈 → 400 FEEDBACK_REQUIRED', r.status === 400 && (await r.json()).error === 'FEEDBACK_REQUIRED');
r = await P(ID2, { action: 'decision', stage: 'synopsis', decision: 'rejected', note: '钩子不够强，重写' });
check('驳回带反馈 → 200', r.status === 200);
r = await idMod.onRequest({ request: get(ID2, null), env, params: { id: ID2 } });
j = await r.json();
check('公开查询显示已驳回', j.stageStatusLabel === '已驳回');
r = await P(ID2, { action: 'stage-content', stage: 'synopsis', content: { episodes: [{ ep: 1, title: 'T1', hook: 'H1', beat: 'B1', paymark: '' }, { ep: 2, title: 'T2', hook: 'H2+', beat: 'B2', paymark: '💎 付费墙①' }] } });
check('重生成 → 再次 pending_review', (await r.json()).stageStatus === 'pending_review');
r = await P(ID2, { action: 'decision', stage: 'synopsis', decision: 'approved' });
check('通过梗概 → 推进到完整剧本', (await r.json()).stage === 'script');

console.log('⑧ 管线：完整剧本（分批合并 + 模块编辑 + 驳回 + 通过）');
const epA = { ep: 1, title: 'The Debt', hook: 'She signs', scenes: [{ no: 1, slug: 'INT. MANSION - NIGHT', action: 'Rain.', lines: [{ s: 'KANE', l: 'You owe me.', lZh: '你欠我的。' }] }] };
const epB = { ep: 2, title: 'Cold Welcome', hook: 'The slap', scenes: [] };
const epC = { ep: 3, title: 'First Blood', hook: 'Rival appears', scenes: [] };
const epD = { ep: 4, title: 'The Contract', hook: 'Terms', scenes: [] };
r = await P(ID2, { action: 'stage-content', stage: 'script', ready: false, content: { episodes: [epA, epB, { ep: 'bad', title: 'x' }] } });
j = await r.json();
check('首批写入（ready:false → draft）→ written=2', j.stageStatus === 'draft' && j.progress.written === 2);
r = await P(ID2, { action: 'stage-content', stage: 'script', ready: false, content: { episodes: [epC, epD] } });
j = await r.json();
check('二批合并 → written=4', j.progress.written === 4);
r = await P(ID2, { action: 'stage-content', stage: 'script', ready: false, content: { episodes: [Object.assign({}, epB, { title: 'Cold Welcome v2' })] } });
j = await r.json();
check('重写 EP02 按 ep 覆盖 → written 仍为 4', j.progress.written === 4);
r = await P(ID2, { action: 'stage-content', stage: 'script', ready: true });
check('finalize → pending_review', (await r.json()).stageStatus === 'pending_review');
r = await idMod.onRequest({ request: get(ID2, 'test-admin-token'), env, params: { id: ID2 } });
j = await r.json();
const eps1 = j.submission.stages.script.content.episodes;
check('EP02 已更新且未标记 edited', eps1.find((e) => e.ep === 2).title === 'Cold Welcome v2' && !eps1.find((e) => e.ep === 2).edited);
r = await P(ID2, { action: 'edit-ep', ep: 2, data: { title: 'Cold Welcome (edited)', hook: 'stronger hook', scenes: [{ no: 1, slug: 'INT. HALL - DAY', action: 'Slap.', lines: [{ s: 'SIENNA', l: 'Know your place.', lZh: '摆正你的位置。' }] }] } });
check('模块化编辑 EP02 → 200 saved', r.status === 200 && (await r.json()).saved === true);
r = await idMod.onRequest({ request: get(ID2, 'test-admin-token'), env, params: { id: ID2 } });
j = await r.json();
const ep2 = j.submission.stages.script.content.episodes.find((e) => e.ep === 2);
check('EP02 带 edited 标记且内容已更新', ep2.edited === true && ep2.title === 'Cold Welcome (edited)' && ep2.scenes[0].lines[0].s === 'SIENNA');
r = await P(ID2, { action: 'decision', stage: 'script', decision: 'rejected', note: '对白太书面' });
check('驳回剧本 → 200', r.status === 200);
r = await P(ID2, { action: 'edit-ep', ep: 3, data: { title: 'First Blood v2', hook: 'x', scenes: [] } });
check('驳回状态下仍可编辑模块', r.status === 200);
r = await P(ID2, { action: 'stage-content', stage: 'script', ready: true });
check('重新送审 → pending_review', (await r.json()).stageStatus === 'pending_review');
r = await P(ID2, { action: 'decision', stage: 'script', decision: 'approved' });
j = await r.json();
check('通过剧本 → 推进到视觉资产·待选择', j.stage === 'assets' && j.stageStatusLabel === '待选择');

console.log('⑨ 管线：资产跳过路径 + 发布 + 锁定防护');
r = await P(ID2, { action: 'assets-choice', choice: 'skip' });
j = await r.json();
check('跳过生图 → 进入发布阶段', j.stage === 'publish' && j.stageStatus === 'skipped');
r = await P(ID2, { action: 'publish-done' });
check('发布缺链接 → 400', r.status === 400);
r = await P(ID2, { action: 'publish-done', feishuDocUrl: 'https://allinagi.feishu.cn/docx/DEMO', pageUrl: 'https://scriptroom.allinagi.com.cn/scripts/script-demo.html' });
j = await r.json();
check('发布完成 → stage=done', j.stage === 'done');
r = await idMod.onRequest({ request: get(ID2, null), env, params: { id: ID2 } });
j = await r.json();
check('公开查询：已完成 + 已上线', j.stageLabel === '已完成' && j.statusLabel === '已上线');
r = await P(ID2, { action: 'edit-ep', ep: 1, data: { title: 'x', hook: 'x', scenes: [] } });
check('非剧本阶段编辑模块 → 400 NOT_SCRIPT_STAGE', r.status === 400 && (await r.json()).error === 'NOT_SCRIPT_STAGE');
r = await indexMod.onRequest({ request: get(null, 'test-admin-token'), env });
j = await r.json();
const listItem = j.submissions.find((s) => s.id === ID2);
check('列表项含阶段摘要且剥离 stages 负载', listItem && listItem.stage === 'done' && listItem.stageStatuses && !listItem.stages);

console.log('⑩ 管线：资产生成路径（选择 / 上传 / 拉取 / 送审 / 通过）');
r = await indexMod.onRequest({ request: post({ ...valid, title: 'Pipeline Test Assets' }), env, waitUntil });
const ID3 = (await r.json()).id;
async function driveToAssets(id) {
  await P(id, { action: 'stage-content', stage: 'outline', content: { logline: 'x' } });
  await P(id, { action: 'decision', stage: 'outline', decision: 'approved' });
  await P(id, { action: 'stage-content', stage: 'synopsis', content: { episodes: [{ ep: 1, title: 'T', hook: 'H', beat: 'B', paymark: '' }] } });
  await P(id, { action: 'decision', stage: 'synopsis', decision: 'approved' });
  await P(id, { action: 'stage-content', stage: 'script', content: { episodes: [epA] } });
  await P(id, { action: 'decision', stage: 'script', decision: 'approved' });
}
await driveToAssets(ID3);
r = await P(ID3, { action: 'asset-put', key: 'cover', dataBase64: Buffer.from('x').toString('base64') });
check('待选择状态下上传 → 400 ASSET_PUT_NOT_ALLOWED', r.status === 400 && (await r.json()).error === 'ASSET_PUT_NOT_ALLOWED');
r = await P(ID3, { action: 'assets-choice', choice: 'generate' });
check('选择生成 → generating', (await r.json()).stageStatus === 'generating');
const imgBytes = new Uint8Array(1200).fill(7);
r = await P(ID3, { action: 'asset-put', key: 'cover', label: 'Key Art 封面', aspect: '9:16', dataBase64: Buffer.from(imgBytes).toString('base64') });
check('上传图片 → 200 items=1', r.status === 200 && (await r.json()).items === 1);
r = await P(ID3, { action: 'asset-put', key: 'Bad-Key!', dataBase64: Buffer.from('x').toString('base64') });
check('非法 key → 400 BAD_IMG_KEY', r.status === 400 && (await r.json()).error === 'BAD_IMG_KEY');
r = await P(ID3, { action: 'asset-put', key: 'big', dataBase64: Buffer.from(new Uint8Array(401 * 1024).fill(1)).toString('base64') });
check('超 400KB → 413 IMG_TOO_LARGE', r.status === 413 && (await r.json()).error === 'IMG_TOO_LARGE');
r = await idMod.onRequest({ request: new Request(BASE + '/' + ID3 + '?img=cover'), env, params: { id: ID3 } });
check('无 token 拉图 → 401', r.status === 401);
r = await idMod.onRequest({ request: new Request(BASE + '/' + ID3 + '?img=cover', { headers: { Authorization: 'Bearer test-admin-token' } }), env, params: { id: ID3 } });
const imgBody = await r.arrayBuffer();
check('管理员拉图 → 200 二进制等长', r.status === 200 && imgBody.byteLength === 1200 && (r.headers.get('Content-Type') || '').startsWith('image/'));
r = await idMod.onRequest({ request: new Request(BASE + '/' + ID3 + '?img=missing', { headers: { Authorization: 'Bearer test-admin-token' } }), env, params: { id: ID3 } });
check('不存在的图 → 404', r.status === 404);
r = await P(ID3, { action: 'stage-content', stage: 'assets', content: { items: [{ key: 'cover', label: 'Key Art 封面', aspect: '9:16', mime: 'image/jpeg' }] } });
check('资产送审 → pending_review', (await r.json()).stageStatus === 'pending_review');
r = await P(ID3, { action: 'decision', stage: 'assets', decision: 'approved' });
check('通过资产 → 发布阶段', (await r.json()).stage === 'publish');
r = await P(ID3, { action: 'publish-done', feishuDocUrl: 'https://allinagi.feishu.cn/docx/D2', pageUrl: 'https://scriptroom.allinagi.com.cn/scripts/d2.html' });
check('发布完成', (await r.json()).stage === 'done');

console.log('⑪ v1.5：编辑密钥鉴权链（提交者入口）');
r = await indexMod.onRequest({ request: post({ ...valid, title: 'Editor Key Test' }), env, waitUntil });
j = await r.json();
const IDE = j.id;
const EKEY = j.editKey;
const ge = (id, key) => idMod.onRequest({ request: new Request(BASE + '/' + id, { headers: { 'X-Edit-Key': key } }), env, params: { id } });
const pe = (id, key, body) => idMod.onRequest({ request: new Request(BASE + '/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Edit-Key': key }, body: JSON.stringify(body) }), env, params: { id } });
r = await ge(IDE, EKEY);
j = await r.json();
check('密钥 GET → 完整记录（role=editor）', r.status === 200 && j.role === 'editor' && j.submission && j.submission.title === 'Editor Key Test');
check('完整记录含 editKeyHash 且不含明文密钥', j.submission.editKeyHash && !j.submission.editKey);
r = await ge(IDE, 'wrongkey12345678');
check('错误密钥 → 401', r.status === 401);
r = await ge(IDE, '');
check('空密钥 → 401', r.status === 401);
r = await idMod.onRequest({ request: new Request(BASE + '/' + IDE + '?key=' + encodeURIComponent(EKEY)), env, params: { id: IDE } });
check('GET ?key= 查询参数鉴权可用', r.status === 200 && (await r.json()).role === 'editor');
r = await indexMod.onRequest({ request: new Request(BASE, { headers: { 'X-Edit-Key': EKEY } }), env });
check('密钥不可访问列表（列表仅管理员）', r.status === 401);

console.log('⑫ v1.5：请求生成 + 提交者编辑确认流转');
r = await pe(IDE, EKEY, { action: 'request-generate', stage: 'synopsis' });
check('对非当前阶段请求 → 400 STAGE_NOT_ACTIVE', r.status === 400 && (await r.json()).error === 'STAGE_NOT_ACTIVE');
r = await pe(IDE, EKEY, { action: 'request-generate', stage: 'bogus' });
check('非法阶段请求 → 400 BAD_STAGE', r.status === 400 && (await r.json()).error === 'BAD_STAGE');
r = await pe(IDE, 'wrongkey12345678', { action: 'request-generate', stage: 'outline' });
check('错误密钥 PATCH → 401', r.status === 401);
r = await pe(IDE, EKEY, { action: 'request-generate', stage: 'outline' });
j = await r.json();
check('请求生成大纲 → requested', r.status === 200 && j.stageStatus === 'requested');
r = await pe(IDE, EKEY, { action: 'request-generate', stage: 'outline' });
check('重复请求幂等 → 仍 200', r.status === 200);
r = await idMod.onRequest({ request: get(IDE, null), env, params: { id: IDE } });
j = await r.json();
check('公开查询显示「已请求生成」', j.stage === 'outline' && j.stageStatusLabel === '已请求生成');
r = await pe(IDE, EKEY, { action: 'stage-content', stage: 'outline', content: { logline: 'manual outline by editor' } });
j = await r.json();
check('requested 状态直接写入 → pending_review', r.status === 200 && j.stageStatus === 'pending_review');
r = await pe(IDE, EKEY, { action: 'request-generate', stage: 'outline' });
check('非空状态再请求 → 400 REQUEST_NOT_ALLOWED', r.status === 400 && (await r.json()).error === 'REQUEST_NOT_ALLOWED');
r = await pe(IDE, EKEY, { action: 'decision', stage: 'outline', decision: 'approved' });
j = await r.json();
check('提交者确认大纲 → 推进分集梗概', r.status === 200 && j.stage === 'synopsis');
r = await pe(IDE, EKEY, { action: 'stage-content', stage: 'synopsis', ready: true, content: { episodes: [{ ep: 1, title: 'T', hook: 'H', beat: 'B', paymark: '' }] } });
check('提交者写入梗概 → pending_review', (await r.json()).stageStatus === 'pending_review');
r = await pe(IDE, EKEY, { action: 'decision', stage: 'synopsis', decision: 'approved' });
check('提交者确认梗概 → 进入完整剧本', (await r.json()).stage === 'script');
r = await pe(IDE, EKEY, { action: 'request-generate', stage: 'script' });
check('剧本阶段空状态请求生成 → requested', (await r.json()).stageStatus === 'requested');

console.log('⑬ 旧记录兼容');
const OLD_ID = 'SR_20260101_OLDREC01';
kvData.set('sub_' + OLD_ID, JSON.stringify({ id: OLD_ID, createdAt: '2026-01-01T00:00:00Z', status: 'received', statusNote: '', title: 'Legacy', idea: 'old record without stages', pairing: 'bg', category: 'mafia', episodes: '60', benchmark: '', contact: '' }));
r = await idMod.onRequest({ request: get(OLD_ID, null), env, params: { id: OLD_ID } });
j = await r.json();
check('旧记录缺省阶段：大纲·未开始', j.stage === 'outline' && j.stageLabel === '大纲' && j.stageStatusLabel === '未开始');
r = await idMod.onRequest({ request: patch(OLD_ID, 'test-admin-token', { status: 'reviewing', note: 'legacy flow still works' }), env, params: { id: OLD_ID } });
check('旧版 PATCH {status} 依然可用', r.status === 200 && (await r.json()).statusLabel === '人工审核中');
r = await idMod.onRequest({ request: new Request(BASE + '/' + OLD_ID, { headers: { 'X-Edit-Key': 'whatever12345678' } }), env, params: { id: OLD_ID } });
check('旧记录无 editKeyHash → 密钥鉴权 401', r.status === 401);

console.log('⑮ v1.6：进度事件流 + stageStatuses');
r = await indexMod.onRequest({ request: post({ ...valid, title: 'Events Test' }), env, waitUntil });
const IDV = (await r.json()).id;
r = await idMod.onRequest({ request: get(IDV, 'test-admin-token'), env, params: { id: IDV } });
j = await r.json();
check('新提交初始化事件流 submitted', r.status === 200 && j.submission.events && j.submission.events.length === 1 && j.submission.events[0].type === 'submitted');
r = await idMod.onRequest({ request: get(IDV, null), env, params: { id: IDV } });
j = await r.json();
check('公开查询含 stageStatuses（全部阶段状态码）', j.stageStatuses && j.stageStatuses.outline === 'empty' && j.stageStatuses.script === 'empty' && j.stageStatuses.done === 'empty');
check('公开查询不含事件流与内容', !j.events && !j.stages);
await P(IDV, { action: 'request-generate', stage: 'outline' });
await P(IDV, { action: 'stage-content', stage: 'outline', content: { logline: 'x' } });
await P(IDV, { action: 'decision', stage: 'outline', decision: 'approved' });
r = await idMod.onRequest({ request: get(IDV, 'test-admin-token'), env, params: { id: IDV } });
j = await r.json();
const evs = j.submission.events;
check('事件流按序记录 request → ready → approved', evs.length === 4 && evs[1].type === 'request' && evs[2].type === 'ready' && evs[3].type === 'approved');
check('approved 事件标注推进目标', evs[3].label.indexOf('分集梗概') >= 0);
r = await idMod.onRequest({ request: get(IDV, null), env, params: { id: IDV } });
j = await r.json();
check('公开 stageStatuses 反映阶段推进（outline=approved）', j.stageStatuses.outline === 'approved' && j.stageStatuses.synopsis === 'empty');

r = await idMod.onRequest({ request: get(ID2, null), env, params: { id: ID2 } });
j = await r.json();
check('完成记录公开 stageStatuses（publish=done / assets=skipped）', j.stageStatuses.publish === 'done' && j.stageStatuses.assets === 'skipped' && j.stageStatuses.outline === 'approved');
r = await idMod.onRequest({ request: get(ID3, 'test-admin-token'), env, params: { id: ID3 } });
j = await r.json();
const t3 = j.submission.events.map((e) => e.type);
check('资产生成路径事件齐全（choice/asset/published）', t3.includes('assets-choice') && t3.includes('asset') && t3.includes('published'));
r = await idMod.onRequest({ request: get(ID2, 'test-admin-token'), env, params: { id: ID2 } });
j = await r.json();
const t2 = j.submission.events.map((e) => e.type);
check('剧本路径含 progress 与 rejected 事件', t2.includes('progress') && t2.includes('rejected'));

r = await indexMod.onRequest({ request: post({ ...valid, title: 'Event Cap Test' }), env, waitUntil });
const IDC = (await r.json()).id;
await P(IDC, { action: 'stage-content', stage: 'outline', content: { logline: 'x' } });
await P(IDC, { action: 'decision', stage: 'outline', decision: 'approved' });
await P(IDC, { action: 'stage-content', stage: 'synopsis', content: { episodes: [{ ep: 1, title: 'T', hook: 'H', beat: 'B', paymark: '' }] } });
await P(IDC, { action: 'decision', stage: 'synopsis', decision: 'approved' });
for (let i = 0; i < 62; i++) await P(IDC, { action: 'stage-content', stage: 'script', ready: false, content: { episodes: [{ ep: (i % 4) + 1, title: 'T' + i, hook: 'H', scenes: [] }] } });
r = await idMod.onRequest({ request: get(IDC, 'test-admin-token'), env, params: { id: IDC } });
j = await r.json();
check('事件流上限 60 条（超出截断）', j.submission.events.length === 60);
check('截断保留最新 progress 事件', j.submission.events[j.submission.events.length - 1].type === 'progress');
check('超出后最早的 submitted 事件被裁剪', !j.submission.events.some((e) => e.type === 'submitted'));

r = await idMod.onRequest({ request: get(OLD_ID, 'test-admin-token'), env, params: { id: OLD_ID } });
j = await r.json();
check('旧记录动作后事件流自动创建（status）', j.submission.events && j.submission.events.length === 1 && j.submission.events[0].type === 'status');

console.log('⑭ 其他方法与 KV 未绑定');
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
