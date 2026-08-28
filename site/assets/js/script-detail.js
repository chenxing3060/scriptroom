/* 项目预演系统 · 预案详情页交互
 * - 决策卡吸顶（P0）
 * - 资产区 lightbox（P0）
 * - 节拍表 ↔ 剧情概念图联动（P1，schema assetRef/beatRef 双向引用的渲染层兑现）
 * - 中英双语切换（浏览器语言自动识别 + 记忆偏好）
 * - 私有预案 token 门（AES-GCM 解密，页面不暴露未公开信息）
 */
(function () {
  'use strict';
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------- 私有预案 token 门 ---------- */
  const cipherNode = $('#plan-cipher');
  if (cipherNode) {
    initPrivateGate(cipherNode);
    return; // 门未解锁前不初始化其它交互
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initInteractions(); autoLang(); });
  } else {
    initInteractions();
    autoLang();
  }

  async function initPrivateGate(cipherNode) {
    const gate = $('#private-gate');
    const input = $('#token-input');
    const err = $('#gate-error');
    const params = new URLSearchParams(location.search);
    const token = params.get('token') || '';
    if (token) tryUnlock(token);

    gate.addEventListener('submit', (e) => { e.preventDefault(); tryUnlock(input.value.trim()); });
    input.addEventListener('input', () => { err.textContent = ''; });

    async function tryUnlock(token) {
      if (!token) return;
      err.textContent = '解密中…';
      try {
        const enc = Uint8Array.from(atob(cipherNode.textContent), (c) => c.charCodeAt(0));
        const iv = enc.slice(0, 12);
        const data = enc.slice(12);
        const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
        const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
        const html = new TextDecoder().decode(plain);
        const target = $('#plan-main-target');
        target.innerHTML = html;
        gate.remove();
        cipherNode.remove();
        history.replaceState(null, '', location.pathname + '?token=' + encodeURIComponent(token));
        initInteractions();
        autoLang();
        return;
      } catch (e) {
        err.textContent = '令牌无效或已失效，请向项目方索取访问链接。';
      }
    }
  }

  /* 通用跳转（角色卡 → 四视图资产） */
  function dataJumps() {
    $$('[data-jump]').forEach((el) => {
      el.addEventListener('click', () => {
        const card = document.getElementById(el.dataset.jump);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('highlight');
        void card.offsetWidth;
        card.classList.add('highlight');
      });
    });
  }

  /* ---------- 主交互 ---------- */
  function initInteractions() {
    stickyBar();
    tocHighlight();
    lightbox();
    beatAssetLinkage();
    dataJumps();
    langToggle();
  }

  /* 决策卡吸顶：滚过决策卡后出现紧凑条 */
  function stickyBar() {
    const bar = $('.sticky-bar');
    const hero = $('.plan-hero');
    if (!bar || !hero) return;
    const toggle = () => bar.classList.toggle('show', window.scrollY > hero.offsetTop + hero.offsetHeight - 90);
    window.addEventListener('scroll', toggle, { passive: true });
    toggle();
  }

  /* 目录高亮 */
  function tocHighlight() {
    const links = $$('.plan-toc a');
    if (!links.length || !('IntersectionObserver' in window)) return;
    const map = new Map();
    links.forEach((l) => map.set(l.getAttribute('href').slice(1), l));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          links.forEach((l) => l.classList.remove('active'));
          const link = map.get(en.target.id);
          if (link) link.classList.add('active');
        }
      });
    }, { rootMargin: '-25% 0px -65% 0px' });
    $$('.plan-section').forEach((s) => io.observe(s));
  }

  /* Lightbox */
  function lightbox() {
    const box = $('.lightbox');
    if (!box) return;
    const imgEl = $('.lightbox-img', box);
    const capEl = $('.lightbox-caption', box);
    const countEl = $('.lightbox-count', box);
    const items = [];
    $$('.asset-media, .char-img').forEach((el, idx) => {
      const img = $('img', el);
      if (!img) return;
      items.push({
        src: img.getAttribute('src'),
        caption: img.getAttribute('data-caption') || img.alt || '',
        spec: img.getAttribute('data-spec') || ''
      });
      el.dataset.lbIndex = String(items.length - 1);
      el.addEventListener('click', () => open(items.length - 1));
    });
    if (!items.length) return;
    let cur = 0;
    function open(i) {
      cur = (i + items.length) % items.length;
      const it = items[cur];
      imgEl.src = it.src;
      imgEl.alt = it.caption;
      capEl.innerHTML = escapeHtml(it.caption) + (it.spec ? '<small>' + escapeHtml(it.spec) + '</small>' : '');
      countEl.textContent = (cur + 1) + ' / ' + items.length;
      box.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function close() { box.classList.remove('open'); document.body.style.overflow = ''; }
    $('.lightbox-close', box).addEventListener('click', close);
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    $('.lightbox-nav.prev', box).addEventListener('click', () => open(cur - 1));
    $('.lightbox-nav.next', box).addEventListener('click', () => open(cur + 1));
    document.addEventListener('keydown', (e) => {
      if (!box.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') open(cur - 1);
      if (e.key === 'ArrowRight') open(cur + 1);
    });
  }

  /* 节拍表 ↔ 剧情图联动 */
  function beatAssetLinkage() {
    $$('.beat-row[data-asset-ref]').forEach((row) => {
      row.addEventListener('click', () => {
        const card = document.getElementById('asset-' + row.dataset.assetRef);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('highlight');
        void card.offsetWidth; /* 重启动画 */
        card.classList.add('highlight');
      });
    });
    $$('.badge.beat-link[data-beat-ref]').forEach((badge) => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = document.getElementById(badge.dataset.beatRef);
        if (!row) return;
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.transition = 'background .3s';
        row.style.background = 'rgba(240,178,62,.14)';
        setTimeout(() => { row.style.background = ''; }, 1600);
      });
    });
  }

  /* 双语切换：构建期注入 data-en，运行期互换 */
  function langToggle() {
    const btn = $('.lang-toggle');
    if (!btn) return;
    let lang = localStorage.getItem('scriptroom-lang') || 'zh';
    apply(lang, false);
    btn.addEventListener('click', () => {
      lang = lang === 'zh' ? 'en' : 'zh';
      localStorage.setItem('scriptroom-lang', lang);
      apply(lang, true);
    });
    function apply(target, animate) {
      document.documentElement.lang = target === 'zh' ? 'zh-CN' : 'en';
      $$('[data-en]').forEach((el) => {
        if (target === 'en') {
          if (el.dataset.zh === undefined) el.dataset.zh = el.textContent;
          if (animate) crossFade(el, el.dataset.en);
          else el.textContent = el.dataset.en;
        } else if (el.dataset.zh !== undefined) {
          if (animate) crossFade(el, el.dataset.zh);
          else el.textContent = el.dataset.zh;
        }
      });
      btn.textContent = target === 'zh' ? 'EN' : '中文';
      document.body.classList.toggle('lang-en', target === 'en');
    }
    function crossFade(el, text) {
      el.style.transition = 'opacity .18s';
      el.style.opacity = '0.15';
      setTimeout(() => { el.textContent = text; el.style.opacity = '1'; }, 160);
    }
  }

  /* 首访按浏览器语言自动切换 */
  function autoLang() {
    if (localStorage.getItem('scriptroom-lang')) return;
    const nav = (navigator.language || '').toLowerCase();
    if (nav.startsWith('en')) {
      const btn = $('.lang-toggle');
      if (btn) btn.click();
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
