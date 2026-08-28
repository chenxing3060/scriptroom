/* 剧本工坊 · 管线审核工作台：列表 / 阶段确认 / 剧本模块化编辑 / 资产审阅 */
(function () {
  'use strict';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  var TOKEN_KEY = 'sr_admin_token';
  var STAGE_LABELS = { outline: '大纲', synopsis: '分集梗概', script: '完整剧本', assets: '视觉资产', publish: '发布上线', done: '已完成' };
  var STAGE_FLOW = ['outline', 'synopsis', 'script', 'assets', 'publish', 'done'];
  var STAGE_STATUS_LABELS = {
    empty: '未开始', draft: '生成中', pending_review: '待确认', approved: '已通过', rejected: '已驳回',
    awaiting_choice: '待选择', generating: '生成中', skipped: '已跳过', pending: '待发布', done: '已完成',
  };
  var PAIRINGS = { bg: 'BG 男女', bl: 'BL 男男', gl: 'GL 女女' };
  var CATEGORIES = {
    'fated-mates': '狼人命定', billionaire: '亿万总裁', mafia: '黑帮契约',
    rebirth: '重生复仇', 'hidden-identity': '隐藏身份', contract: '契约婚姻',
  };

  var state = { token: '', list: [], rec: null, curEp: 0, note: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function api(method, path, body, raw) {
    var opt = { method: method, headers: { 'Authorization': 'Bearer ' + state.token } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      if (raw) return r;
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.message || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var t = new Date(iso);
    return isNaN(t.getTime()) ? String(iso) : t.toLocaleString('zh-CN');
  }

  function stageOfRec(rec) { return rec && rec.stage && STAGE_LABELS[rec.stage] ? rec.stage : 'outline'; }
  function entryOf(rec, stage) { return (rec && rec.stages && rec.stages[stage]) || null; }
  function statusOf(rec, stage) { var e = entryOf(rec, stage); return e && e.status ? e.status : 'empty'; }

  /* ---------- token 门 ---------- */

  function initToken() {
    var saved = localStorage.getItem(TOKEN_KEY);
    if (saved) { state.token = saved; verifyToken(true); }
    $('#pl-token-btn').addEventListener('click', function () { verifyToken(false); });
    $('#pl-token-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') verifyToken(false); });
  }

  function verifyToken(silent) {
    var input = $('#pl-token-input');
    var v = (input.value || '').trim();
    if (v) state.token = v;
    if (!state.token) { if (!silent) showTokenErr('请输入 ADMIN_TOKEN'); return; }
    api('GET', '/api/submissions').then(function () {
      localStorage.setItem(TOKEN_KEY, state.token);
      enterApp();
    }).catch(function (ex) {
      localStorage.removeItem(TOKEN_KEY);
      $('#pl-app').hidden = true;
      $('#pl-token').hidden = false;
      showTokenErr(ex.message === '鉴权失败' ? '令牌不正确，请重新输入' : ('验证失败：' + ex.message));
    });
  }

  function showTokenErr(msg) { var e = $('#pl-token-err'); e.textContent = msg; e.hidden = false; }

  function enterApp() {
    $('#pl-token-err').hidden = true;
    $('#pl-token').hidden = true;
    $('#pl-app').hidden = false;
    var id = new URLSearchParams(location.search).get('id');
    if (id) openDetail(id); else loadList();
  }

  /* ---------- 列表视图 ---------- */

  function loadList() {
    $('#pl-detail-view').hidden = true;
    $('#pl-list-view').hidden = false;
    var box = $('#pl-list');
    box.innerHTML = '<p class="pl-muted">加载中…</p>';
    api('GET', '/api/submissions').then(function (j) {
      state.list = j.submissions || [];
      renderList();
    }).catch(function (ex) { box.innerHTML = '<p class="pl-err">加载失败：' + esc(ex.message) + '</p>'; });
  }

  function renderList() {
    var box = $('#pl-list');
    $('#pl-count').textContent = state.list.length + ' 条提交';
    if (!state.list.length) {
      box.innerHTML = '<p class="pl-muted">暂无提交。用户在「撰写新剧本」页提交后，创意将出现在这里，随后进入五阶段确认管线。</p>';
      return;
    }
    var rows = state.list.map(function (r) {
      var badge = '<span class="pl-badge st-' + esc(r.stageStatus || 'empty') + '">' +
        esc(STAGE_LABELS[r.stage] || r.stage || '大纲') + ' · ' + esc(STAGE_STATUS_LABELS[r.stageStatus] || r.stageStatus || '未开始') + '</span>';
      return '<tr class="pl-row" data-id="' + esc(r.id) + '">' +
        '<td class="pl-mono">' + esc(r.id) + '</td>' +
        '<td><b>' + esc(r.title) + '</b></td>' +
        '<td>' + esc(PAIRINGS[r.pairing] || r.pairing || '—') + '</td>' +
        '<td>' + esc(CATEGORIES[r.category] || r.category || '—') + '</td>' +
        '<td>' + esc(r.episodes || '?') + ' 集</td>' +
        '<td>' + badge + '</td>' +
        '<td class="pl-muted pl-time">' + esc(fmtTime(r.updatedAt || r.createdAt)) + '</td>' +
        '</tr>';
    }).join('');
    box.innerHTML = '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>编号</th><th>剧名</th><th>配向</th><th>母题</th><th>体量</th><th>当前阶段</th><th>更新时间</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    $$('.pl-row', box).forEach(function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-id')); });
    });
  }

  /* ---------- 详情视图 ---------- */

  function openDetail(id) {
    $('#pl-list-view').hidden = true;
    $('#pl-detail-view').hidden = false;
    history.replaceState(null, '', location.pathname + '?id=' + encodeURIComponent(id));
    loadDetail(id);
  }

  function loadDetail(id) {
    $('#pl-stage-panel').innerHTML = '<p class="pl-muted">加载中…</p>';
    api('GET', '/api/submissions/' + encodeURIComponent(id)).then(function (j) {
      state.rec = j.submission;
      renderDetail();
    }).catch(function (ex) {
      $('#pl-stage-panel').innerHTML = '<p class="pl-err">加载失败：' + esc(ex.message) + '</p>';
    });
  }

  function renderDetail() {
    var rec = state.rec;
    $('#pl-head').innerHTML =
      '<div class="pl-head-row"><h2>《' + esc(rec.title) + '》</h2>' +
      '<button id="pl-reload" class="pl-btn pl-btn-ghost" type="button">刷新状态</button></div>' +
      '<div class="pl-meta">' +
      '<span class="pl-chip">' + esc(PAIRINGS[rec.pairing] || rec.pairing) + '</span>' +
      '<span class="pl-chip">' + esc(CATEGORIES[rec.category] || rec.category) + '</span>' +
      '<span class="pl-chip">' + esc(rec.episodes) + ' 集 × 90s 竖屏</span>' +
      '<span class="pl-chip pl-mono">' + esc(rec.id) + '</span>' +
      '<span class="pl-chip">提交于 ' + esc(fmtTime(rec.createdAt)) + '</span>' +
      '</div>' +
      (rec.idea ? '<p class="pl-idea">' + esc(rec.idea) + '</p>' : '') +
      (rec.benchmark ? '<p class="pl-muted">对标：' + esc(rec.benchmark) + '</p>' : '');
    $('#pl-reload').addEventListener('click', function () { loadDetail(rec.id); });
    renderTimeline();
    renderStagePanel();
  }

  function renderTimeline() {
    var rec = state.rec;
    var cur = stageOfRec(rec);
    var nodes = STAGE_FLOW.map(function (s) {
      var ss = s === 'done' ? (cur === 'done' ? 'done' : 'empty') : statusOf(rec, s);
      var cls = s === cur ? ' active' : '';
      return '<div class="pl-node' + cls + ' st-' + esc(ss) + '">' +
        '<div class="pl-node-dot"></div>' +
        '<div class="pl-node-label">' + esc(STAGE_LABELS[s]) + '</div>' +
        '<div class="pl-node-status">' + esc(STAGE_STATUS_LABELS[ss] || ss) + '</div>' +
        '</div>';
    }).join('');
    $('#pl-timeline').innerHTML = '<div class="pl-track">' + nodes + '</div>';
  }

  /* ---------- 阶段面板 ---------- */

  function stBadge(status) { return ' <span class="pl-badge st-' + esc(status) + '">' + esc(STAGE_STATUS_LABELS[status] || status) + '</span>'; }

  function waitHtml(title, sub) {
    return '<div class="pl-wait"><div class="pl-wait-icon">⏳</div><h3>' + esc(title) + '</h3>' +
      '<p class="pl-muted">' + esc(sub) + '</p>' +
      '<button type="button" class="pl-btn pl-btn-ghost" id="pl-wait-reload">刷新状态</button></div>';
  }

  function rejectedHtml(label, entry) {
    return '<div class="pl-rejected"><h3>「' + esc(label) + '」已驳回</h3>' +
      '<p class="pl-rejected-feedback">' + esc(entry && entry.feedback || '（无反馈内容）') + '</p>' +
      '<p class="pl-muted">等待 AI 根据反馈重新生成，完成后将再次送审。' +
      (label === '完整剧本' ? '期间你仍可在线编辑已生成的剧集。' : '') + '</p></div>';
  }

  function rejectedNote(entry) {
    return '<div class="pl-rejected-note">上一轮驳回反馈：' + esc(entry && entry.feedback || '') + '</div>';
  }

  function decisionBar() {
    return '<div class="pl-decision">' +
      '<textarea id="pl-decision-note" rows="3" placeholder="驳回时必填反馈意见；通过时可留空">' + esc(state.note || '') + '</textarea>' +
      '<div class="pl-decision-btns">' +
      '<button type="button" class="pl-btn pl-btn-ok" id="pl-approve">✓ 通过本阶段</button>' +
      '<button type="button" class="pl-btn pl-btn-reject" id="pl-reject">✗ 驳回</button>' +
      '</div>' +
      '<p class="pl-muted">通过后进入下一阶段；驳回需填写反馈，AI 将重新生成本阶段内容。</p>' +
      '</div>';
  }

  function renderStagePanel() {
    var rec = state.rec;
    var stage = stageOfRec(rec);
    var entry = entryOf(rec, stage) || {};
    var status = entry.status || 'empty';
    var html = '';
    if (stage === 'outline') html = panelOutline(rec, entry, status);
    else if (stage === 'synopsis') html = panelSynopsis(rec, entry, status);
    else if (stage === 'script') html = panelScript(rec, entry, status);
    else if (stage === 'assets') html = panelAssets(rec, entry, status);
    else html = panelPublish(rec, entry, status);
    $('#pl-stage-panel').innerHTML = html;
    bindPanel(stage, status);
  }

  /* ---- 阶段 1：大纲 ---- */
  function panelOutline(rec, entry, status) {
    if (status === 'empty' || status === 'draft' || status === 'generating')
      return waitHtml('大纲生成中…', 'AI 正在撰写剧本大纲（世界观 / 人物 / 五幕主线 / 付费卡点策略）。');
    if (status === 'rejected') return rejectedHtml('大纲', entry);
    var c = (entry && entry.content) || {};
    var chars = (c.mainChars || []).map(function (m) {
      return '<tr><td><b>' + esc(m.name) + '</b>' + (m.nameZh ? '<br><span class="pl-muted">' + esc(m.nameZh) + '</span>' : '') + '</td>' +
        '<td>' + esc(m.role || '') + '</td><td>' + esc(m.arc || '') + '</td></tr>';
    }).join('');
    var acts = (c.fiveActs || []).map(function (a) {
      return '<div class="pl-act"><div class="pl-act-head"><b>' + esc(a.title || '') + '</b><span class="pl-muted">' + esc(a.epRange || '') + '</span></div>' +
        '<p>' + esc(a.summary || '') + '</p></div>';
    }).join('');
    var tags = (c.genreTags || []).map(function (t) { return '<span class="pl-chip">' + esc(t) + '</span>'; }).join('');
    function blk(k, v) { return v ? '<div class="pl-block"><div class="pl-k">' + esc(k) + '</div><p>' + esc(v) + '</p></div>' : ''; }
    return '<h3 class="pl-stage-title">阶段 1/5 · 剧本大纲' + stBadge(status) + '</h3>' +
      blk('Logline（英文）', c.logline) + blk('Logline（中文）', c.loglineZh) +
      (tags ? '<div class="pl-block"><div class="pl-k">题材标签</div>' + tags + '</div>' : '') +
      blk('世界观设定', c.setting) + blk('主题与情绪', c.themes) + blk('CP 动力学', c.cpDynamics) + blk('付费卡点策略', c.paywallStrategy) +
      (chars ? '<div class="pl-block"><div class="pl-k">主要人物</div><div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>人物</th><th>定位</th><th>人物弧光</th></tr></thead><tbody>' + chars + '</tbody></table></div></div>' : '') +
      (acts ? '<div class="pl-block"><div class="pl-k">五幕主线</div>' + acts + '</div>' : '') +
      decisionBar();
  }

  /* ---- 阶段 2：分集梗概 ---- */
  function panelSynopsis(rec, entry, status) {
    if (status === 'empty' || status === 'draft')
      return waitHtml('分集梗概生成中…', '大纲已通过，AI 正在撰写全 ' + (rec.episodes || '?') + ' 集分集梗概与钩子。');
    if (status === 'rejected') return rejectedHtml('分集梗概', entry);
    var eps = (entry.content && entry.content.episodes) || [];
    if (!eps.length) return waitHtml('分集梗概生成中…', '尚未写入内容。');
    var ol = entryOf(rec, 'outline');
    var acts = (ol && ol.content && ol.content.fiveActs) || [];
    var rows = eps.map(function (e) {
      var pm = e.paymark ? '<span class="pl-paymark">' + esc(e.paymark) + '</span>' : '';
      return '<tr><td class="pl-mono">EP' + String(e.ep).padStart(2, '0') + '</td>' +
        '<td><b>' + esc(e.title) + '</b></td><td>' + esc(e.hook || '') + '</td>' +
        '<td class="pl-muted">' + esc(e.beat || '') + '</td><td>' + pm + '</td></tr>';
    }).join('');
    var groupNote = acts.length
      ? '<p class="pl-muted">幕划分：' + acts.map(function (a) { return esc(a.title) + '（' + esc(a.epRange || '') + '）'; }).join(' / ') + '</p>'
      : '';
    return '<h3 class="pl-stage-title">阶段 2/5 · 分集梗概' + stBadge(status) + '</h3>' +
      '<p class="pl-muted">共 ' + eps.length + ' / ' + (rec.episodes || '?') + ' 集' + (eps.length < Number(rec.episodes) ? '（尚未写完）' : '') + '</p>' +
      groupNote +
      '<div class="pl-block"><div class="pl-table-wrap pl-ep-scroll"><table class="pl-table"><thead><tr><th>集</th><th>标题</th><th>钩子</th><th>剧情节拍</th><th>标记</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      decisionBar();
  }

  /* ---- 阶段 3：完整剧本（模块化编辑器） ---- */
  function panelScript(rec, entry, status) {
    if (status === 'empty' || status === 'draft') {
      var p = entry && entry.progress;
      return waitHtml('完整剧本生成中…',
        (p ? '已生成 ' + p.written + ' / ' + p.total + ' 集。' : '分集梗概已通过，AI 正在分批撰写全集完整剧本。') +
        '生成完成后可逐集审阅与在线编辑。');
    }
    var eps = (entry.content && entry.content.episodes) || [];
    if (!eps.length) {
      return status === 'rejected' ? rejectedHtml('完整剧本', entry) : waitHtml('完整剧本生成中…', '内容尚未写入。');
    }
    var total = Number(rec.episodes) || 72;
    if (!state.curEp || !eps.some(function (e) { return e.ep === state.curEp; })) state.curEp = eps[0].ep;
    var grid = '';
    for (var i = 1; i <= total; i++) {
      var e = null;
      for (var k = 0; k < eps.length; k++) if (eps[k].ep === i) { e = eps[k]; break; }
      var cls = 'pl-ep-btn' + (e ? ' written' : '') + (e && e.edited ? ' edited' : '') + (i === state.curEp ? ' active' : '');
      grid += '<button type="button" class="' + cls + '" data-ep="' + i + '">' + i + (e && e.edited ? '<i>改</i>' : '') + '</button>';
    }
    var editedCount = eps.filter(function (x) { return x.edited; }).length;
    return '<h3 class="pl-stage-title">阶段 3/5 · 完整剧本' + stBadge(status) + '</h3>' +
      '<p class="pl-muted">已生成 ' + eps.length + ' / ' + total + ' 集' + (editedCount ? ' · 你已编辑 ' + editedCount + ' 集' : '') +
      '。点击左侧集数查看与编辑，编辑后记得点「保存本集」。</p>' +
      (status === 'rejected' ? rejectedNote(entry) : '') +
      '<div class="pl-script-layout">' +
      '<div class="pl-ep-grid">' + grid + '</div>' +
      '<div class="pl-ep-editor" id="pl-ep-editor"></div>' +
      '</div>' +
      decisionBar();
  }

  function renderEpEditor() {
    var rec = state.rec;
    var entry = entryOf(rec, 'script') || {};
    var eps = (entry.content && entry.content.episodes) || [];
    var ep = null;
    for (var i = 0; i < eps.length; i++) if (eps[i].ep === state.curEp) { ep = eps[i]; break; }
    var box = $('#pl-ep-editor');
    if (!box) return;
    if (!ep) { box.innerHTML = '<p class="pl-muted">第 ' + state.curEp + ' 集尚未生成。</p>'; return; }
    var scenesHtml = (ep.scenes || []).map(function (sc, si) {
      var lines = (sc.lines || []).map(function (l, li) {
        return '<div class="pl-line-row">' +
          '<input class="pl-in pl-in-speaker" value="' + esc(l.s) + '" placeholder="角色">' +
          '<input class="pl-in pl-in-en" value="' + esc(l.l) + '" placeholder="英文对白">' +
          '<input class="pl-in pl-in-zh" value="' + esc(l.lZh) + '" placeholder="中文对照">' +
          '<button type="button" class="pl-mini del-line" title="删除此行">×</button>' +
          '</div>';
      }).join('');
      return '<div class="pl-scene">' +
        '<div class="pl-scene-head"><span>场景 ' + (si + 1) + '</span><button type="button" class="pl-mini del-scene">删除场景</button></div>' +
        '<input class="pl-in pl-in-slug" value="' + esc(sc.slug) + '" placeholder="场景标注，如 INT. MANSION - HALL - NIGHT">' +
        '<textarea class="pl-ta pl-ta-action" rows="2" placeholder="动作 / 导演提示">' + esc(sc.action) + '</textarea>' +
        '<div class="pl-lines">' + (lines || '<p class="pl-muted">暂无对白</p>') + '</div>' +
        '<button type="button" class="pl-mini add-line">+ 对白行</button>' +
        '</div>';
    }).join('');
    box.innerHTML =
      '<div class="pl-ep-form" data-ep="' + ep.ep + '">' +
      '<div class="pl-ep-form-head"><b>EP' + String(ep.ep).padStart(2, '0') + '</b>' +
      (ep.edited ? '<span class="pl-edited-tag">已编辑</span>' : '') + '</div>' +
      '<input class="pl-in pl-in-title" value="' + esc(ep.title) + '" placeholder="本集标题">' +
      '<input class="pl-in pl-in-hook" value="' + esc(ep.hook) + '" placeholder="本集钩子（结尾悬念）">' +
      '<div class="pl-scenes">' + (scenesHtml || '<p class="pl-muted">暂无场景，点击下方添加。</p>') + '</div>' +
      '<div class="pl-ep-actions">' +
      '<button type="button" class="pl-mini add-scene">+ 添加场景</button>' +
      '<button type="button" class="pl-btn pl-btn-save" id="pl-save-ep">保存本集</button>' +
      '</div></div>';
  }

  function sceneTpl() {
    return '<div class="pl-scene">' +
      '<div class="pl-scene-head"><span>场景</span><button type="button" class="pl-mini del-scene">删除场景</button></div>' +
      '<input class="pl-in pl-in-slug" placeholder="场景标注，如 INT. MANSION - HALL - NIGHT">' +
      '<textarea class="pl-ta pl-ta-action" rows="2" placeholder="动作 / 导演提示"></textarea>' +
      '<div class="pl-lines"></div>' +
      '<button type="button" class="pl-mini add-line">+ 对白行</button>' +
      '</div>';
  }

  function lineTpl() {
    return '<div class="pl-line-row">' +
      '<input class="pl-in pl-in-speaker" placeholder="角色">' +
      '<input class="pl-in pl-in-en" placeholder="英文对白">' +
      '<input class="pl-in pl-in-zh" placeholder="中文对照">' +
      '<button type="button" class="pl-mini del-line" title="删除此行">×</button>' +
      '</div>';
  }

  function bindEpEditor() {
    var box = $('#pl-ep-editor');
    if (!box) return;

    $$('.pl-ep-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.curEp = Number(b.getAttribute('data-ep'));
        renderStagePanel();
      });
    });

    box.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || t.nodeType !== 1) return;
      if (t.classList.contains('add-scene')) {
        var cont = $('.pl-scenes', box);
        if (cont) cont.insertAdjacentHTML('beforeend', sceneTpl());
      } else if (t.classList.contains('del-scene')) {
        var sc = t.closest('.pl-scene');
        if (sc) sc.remove();
      } else if (t.classList.contains('add-line')) {
        var sc2 = t.closest('.pl-scene');
        var lines = sc2 ? $('.pl-lines', sc2) : null;
        if (lines) lines.insertAdjacentHTML('beforeend', lineTpl());
      } else if (t.classList.contains('del-line')) {
        var row = t.closest('.pl-line-row');
        if (row) row.remove();
      } else if (t.id === 'pl-save-ep') {
        saveCurrentEp(t);
      }
    });
  }

  function collectEpData() {
    var form = $('#pl-ep-editor .pl-ep-form');
    if (!form) return null;
    var scenes = $$('.pl-scene', form).map(function (scEl, si) {
      var lines = $$('.pl-line-row', scEl).map(function (lr) {
        return {
          s: ($('.pl-in-speaker', lr) || {}).value || '',
          l: ($('.pl-in-en', lr) || {}).value || '',
          lZh: ($('.pl-in-zh', lr) || {}).value || '',
        };
      });
      return {
        no: si + 1,
        slug: ($('.pl-in-slug', scEl) || {}).value || '',
        action: ($('.pl-ta-action', scEl) || {}).value || '',
        lines: lines,
      };
    });
    return {
      ep: Number(form.getAttribute('data-ep')),
      title: ($('.pl-in-title', form) || {}).value || '',
      hook: ($('.pl-in-hook', form) || {}).value || '',
      scenes: scenes,
    };
  }

  function saveCurrentEp(btn) {
    var d = collectEpData();
    if (!d) return;
    btn.disabled = true;
    btn.textContent = '保存中…';
    api('PATCH', '/api/submissions/' + state.rec.id, {
      action: 'edit-ep', ep: d.ep, data: { title: d.title, hook: d.hook, scenes: d.scenes },
    }).then(function () {
      var entry = entryOf(state.rec, 'script');
      var eps = entry.content.episodes;
      var ne = { ep: d.ep, title: d.title, hook: d.hook, scenes: d.scenes, edited: true };
      var idx = -1;
      for (var i = 0; i < eps.length; i++) if (eps[i].ep === d.ep) { idx = i; break; }
      if (idx >= 0) eps[idx] = ne; else eps.push(ne);
      renderStagePanel();
    }).catch(function (ex) {
      alert('保存失败：' + ex.message);
      btn.disabled = false;
      btn.textContent = '保存本集';
    });
  }

  /* ---- 阶段 4：视觉资产 ---- */
  function panelAssets(rec, entry, status) {
    if (status === 'empty')
      return waitHtml('等待选择…', '剧本已通过，即将进入视觉资产选择。');
    if (status === 'awaiting_choice')
      return '<h3 class="pl-stage-title">阶段 4/5 · 视觉资产' + stBadge(status) + '</h3>' +
        '<p class="pl-muted">选择「生成」将由 AI 产出 Key Art 封面 / 角色设定图 / 场景概念图（需数分钟，完成后自动送审）；' +
        '选择「跳过生图」则直接进入发布阶段，线上页面将以主题色渐变占位封面、不展示资产区块。</p>' +
        '<div class="pl-choice-btns">' +
        '<button type="button" class="pl-btn pl-btn-ok" id="pl-assets-gen">生成视觉资产</button>' +
        '<button type="button" class="pl-btn pl-btn-ghost" id="pl-assets-skip">跳过生图</button>' +
        '</div>';
    if (status === 'generating')
      return waitHtml('视觉资产生成中…', '已选择生成，AI 正在产出图片并逐张上传（Key Art / 角色设定 / 场景概念）。');
    var items = (entry.content && entry.content.items) || [];
    if (status === 'rejected' && !items.length) return rejectedHtml('视觉资产', entry);
    var gal = items.map(function (it) {
      return '<figure class="pl-asset"><img data-imgkey="' + esc(it.key) + '" alt="' + esc(it.label) + '">' +
        '<figcaption>' + esc(it.label) + (it.aspect ? ' · ' + esc(it.aspect) : '') + '</figcaption></figure>';
    }).join('');
    return '<h3 class="pl-stage-title">阶段 4/5 · 视觉资产' + stBadge(status) + '</h3>' +
      (status === 'rejected' ? rejectedNote(entry) : '') +
      '<div class="pl-asset-grid">' + (gal || '<p class="pl-muted">暂无图片</p>') + '</div>' +
      decisionBar();
  }

  function loadAssetImages() {
    $$('#pl-stage-panel img[data-imgkey]').forEach(function (img) {
      var key = img.getAttribute('data-imgkey');
      api('GET', '/api/submissions/' + state.rec.id + '?img=' + encodeURIComponent(key), undefined, true)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (b) { img.src = URL.createObjectURL(b); })
        .catch(function () { img.alt = '图片加载失败'; });
    });
  }

  function assetsChoice(choice) {
    if (choice === 'skip' && !confirm('确认跳过视觉资产生成，直接进入发布阶段？')) return;
    if (choice === 'generate' && !confirm('确认开始生成视觉资产？AI 将产出封面 / 角色 / 场景图，需要数分钟。')) return;
    api('PATCH', '/api/submissions/' + state.rec.id, { action: 'assets-choice', choice: choice })
      .then(function () { loadDetail(state.rec.id); })
      .catch(function (ex) { alert('操作失败：' + ex.message); });
  }

  /* ---- 阶段 5：发布 ---- */
  function panelPublish(rec, entry, status) {
    if (status === 'done' || stageOfRec(rec) === 'done') {
      var c = (entry && entry.content) || {};
      return '<h3 class="pl-stage-title">已完成 🎉</h3>' +
        (c.feishuDocUrl ? '<p><a class="pl-link" target="_blank" rel="noopener" href="' + esc(c.feishuDocUrl) + '">飞书在线文档（可编辑 / 导出 Word · PDF）→</a></p>' : '') +
        (c.pageUrl ? '<p><a class="pl-link" target="_blank" rel="noopener" href="' + esc(c.pageUrl) + '">线上剧本详情页 →</a></p>' : '') +
        (c.deployedAt ? '<p class="pl-muted">发布于 ' + esc(fmtTime(c.deployedAt)) + '</p>' : '');
    }
    return waitHtml('等待发布…',
      '全部阶段已确认。发布动作：创建飞书文档并归档 → 生成线上详情页并注册剧本库 → 加密上线。完成后此处将显示访问链接。');
  }

  /* ---------- 决策 ---------- */

  function bindDecision(stage) {
    var note = $('#pl-decision-note');
    if (note) note.addEventListener('input', function () { state.note = note.value; });
    var ok = $('#pl-approve');
    var rj = $('#pl-reject');
    if (ok) ok.addEventListener('click', function () { decide(stage, 'approved'); });
    if (rj) rj.addEventListener('click', function () { decide(stage, 'rejected'); });
  }

  function decide(stage, decision) {
    var note = (state.note || '').trim();
    if (decision === 'rejected' && !note) { alert('驳回时请填写反馈意见'); return; }
    if (!confirm(decision === 'approved'
      ? '确认通过「' + STAGE_LABELS[stage] + '」阶段？'
      : '确认驳回「' + STAGE_LABELS[stage] + '」阶段？')) return;
    api('PATCH', '/api/submissions/' + state.rec.id, {
      action: 'decision', stage: stage, decision: decision, note: note,
    }).then(function () {
      state.note = '';
      loadDetail(state.rec.id);
    }).catch(function (ex) { alert('操作失败：' + ex.message); });
  }

  /* ---------- 面板事件绑定 ---------- */

  function bindPanel(stage, status) {
    var waitReload = $('#pl-wait-reload');
    if (waitReload) waitReload.addEventListener('click', function () { loadDetail(state.rec.id); });

    if (stage === 'script' && (status === 'pending_review' || status === 'rejected')) {
      renderEpEditor();
      bindEpEditor();
    }
    if (status === 'pending_review') bindDecision(stage);
    if (stage === 'assets') {
      if (status === 'awaiting_choice') {
        var g = $('#pl-assets-gen');
        var s = $('#pl-assets-skip');
        if (g) g.addEventListener('click', function () { assetsChoice('generate'); });
        if (s) s.addEventListener('click', function () { assetsChoice('skip'); });
      }
      loadAssetImages();
    }
  }

  /* ---------- init ---------- */

  function init() {
    initToken();
    $('#pl-refresh').addEventListener('click', loadList);
    $('#pl-back').addEventListener('click', function () {
      history.replaceState(null, '', location.pathname);
      loadList();
    });
  }

  init();
})();
