/* public/js/sig.js — сбор признаков окружения для защиты от мультиаккаунтов.
 *
 * ВАЖНО:
 *  • Ничего не сохраняется в браузере (ни localStorage, ни sessionStorage,
 *    ни cookie, ни IndexedDB) — нарушителю нечего чистить; признаки считаются
 *    заново при каждом заходе.
 *  • На сервер уходят только хэши (SHA-256, обрезанные), а не сырые значения.
 *  • Ничего не блокирует: результат нужен только модераторам как одно из
 *    свидетельств (см. privacy.html, раздел 2.4).
 */
(function () {
  'use strict';
  if (window.__chSig) return;
  window.__chSig = true;

  const API = '/api/sig';

  // ── хэш ────────────────────────────────────────────────────────
  async function sha(str) {
    try {
      const buf = new TextEncoder().encode(String(str));
      const dig = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(dig)).slice(0, 16)
        .map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      // нет crypto.subtle (не https) — простой двойной FNV-1a
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      const s = String(str);
      for (let i = 0; i < s.length; i++) {
        h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x85ebca6b) >>> 0;
      }
      return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
    }
  }

  // Приводим строку видеокарты к виду, одинаковому в Chrome/Edge/Firefox на одной машине:
  // «ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11) Google Inc.» и
  // «NVIDIA GeForce RTX 3060/PCIe/SSE2 NVIDIA Corporation» → «3060 geforce nvidia rtx».
  // Убираем служебные слова, дубли и порядок слов.
  const GPU_NOISE = /\b(angle|google|inc|ltd|llc|corp|corporation|direct3d\d*|d3d\d+|vs_\d_\d|ps_\d_\d|opengl|engine|pcie|sse2|metal|vulkan|mesa|gl|\d+\.\d+(\.\d+)*)\b/g;
  function normGpu(s) {
    const toks = String(s || '').toLowerCase()
      .replace(/\(r\)|\(tm\)/g, ' ')
      .replace(GPU_NOISE, ' ')
      .split(/[^a-z0-9]+/).filter(Boolean);
    return Array.from(new Set(toks)).sort().join(' ');
  }

  // ── сборщики (каждый возвращает строку или null) ───────────────
  function glInfo() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const params = [
        gl.MAX_TEXTURE_SIZE, gl.MAX_RENDERBUFFER_SIZE, gl.MAX_VERTEX_ATTRIBS,
        gl.MAX_TEXTURE_IMAGE_UNITS, gl.MAX_VARYING_VECTORS, gl.MAX_VERTEX_UNIFORM_VECTORS,
      ].map(p => String(gl.getParameter(p)));
      params.push(String(Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [])));
      params.push(String(Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || [])));
      return { gpu: normGpu(renderer + ' ' + vendor), gl: params.join('|') };
    } catch (e) { return null; }
  }

  function screenInfo() {
    try {
      const w = Math.max(screen.width, screen.height), h = Math.min(screen.width, screen.height);
      return [w, h, (window.devicePixelRatio || 1).toFixed(2), screen.colorDepth || 0,
        navigator.hardwareConcurrency || 0].join('x');
    } catch (e) { return null; }
  }

  function locInfo() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const lang = String((navigator.languages && navigator.languages[0]) || navigator.language || '')
        .toLowerCase().split('-')[0];
      return tz + '|' + lang;
    } catch (e) { return null; }
  }

  const FONTS = [
    // Windows
    'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Candara', 'Corbel', 'Constantia', 'Franklin Gothic Medium',
    'Gabriola', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft YaHei', 'MS Gothic',
    'Palatino Linotype', 'Sylfaen', 'Tahoma', 'Trebuchet MS', 'Verdana', 'Segoe Print', 'Segoe Script',
    'Ebrima', 'Nirmala UI', 'Leelawadee', 'Gadugi', 'Bahnschrift', 'Cascadia Code', 'SimSun', 'Yu Gothic',
    'Arial Narrow', 'Arial Black', 'Century Gothic', 'Impact', 'Comic Sans MS', 'Segoe UI Emoji',
    // macOS / iOS
    'Helvetica Neue', 'Menlo', 'Monaco', 'Avenir', 'Avenir Next', 'Optima', 'Gill Sans', 'Futura',
    'Hoefler Text', 'Lucida Grande', 'Apple Chancery', 'Baskerville', 'Didot', 'American Typewriter',
    'PingFang SC', 'Hiragino Sans', 'Apple Color Emoji', 'San Francisco',
    // Linux / Android
    'DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans', 'Cantarell', 'Droid Sans', 'Fira Sans', 'Roboto',
    'Noto Color Emoji', 'Open Sans',
    // ставятся вместе с ПО
    'Calibri Light', 'Rockwell', 'Garamond', 'Bookman Old Style', 'Minion Pro', 'Myriad Pro',
    'Source Sans Pro', 'Lato', 'Montserrat', 'Wingdings', 'MS Reference Sans Serif', 'Book Antiqua',
    'Agency FB', 'Berlin Sans FB', 'Bodoni MT', 'Britannic Bold', 'Broadway', 'Copperplate Gothic Light',
  ];
  function fontsInfo() {
    try {
      const text = 'mmmmmmmmmmlliWWwwi10Оф';
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const bases = ['monospace', 'sans-serif', 'serif'];
      const width = (font) => { ctx.font = '72px ' + font; return ctx.measureText(text).width; };
      const baseW = bases.map(b => width(b));
      let bits = '', found = 0;
      for (const f of FONTS) {
        let has = false;
        for (let i = 0; i < bases.length; i++) {
          if (width('"' + f + '",' + bases[i]) !== baseW[i]) { has = true; break; }
        }
        bits += has ? '1' : '0';
        if (has) found++;
      }
      return found >= 3 ? bits : null;   // меньше 3 — режим приватности/нет данных
    } catch (e) { return null; }
  }

  function canvasInfo() {
    try {
      const c = document.createElement('canvas');
      c.width = 240; c.height = 60;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#f60'; ctx.fillRect(100, 1, 62, 20);
      ctx.fillStyle = '#069'; ctx.font = '15px Arial, sans-serif';
      ctx.fillText('Chess Home ♞♟ Шахматы 🙂', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.font = '18px serif';
      ctx.fillText('Chess Home ♞♟ Шахматы 🙂', 4, 40);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = 'rgb(255,0,255)'; ctx.beginPath(); ctx.arc(50, 30, 20, 0, Math.PI * 2, true); ctx.fill();
      return c.toDataURL();
    } catch (e) { return null; }
  }

  function audioInfo() {
    return new Promise(resolve => {
      try {
        const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) return resolve(null);
        const ctx = new Ctx(1, 5000, 44100);
        const osc = ctx.createOscillator();
        osc.type = 'triangle'; osc.frequency.value = 10000;
        const comp = ctx.createDynamicsCompressor();
        [['threshold', -50], ['knee', 40], ['ratio', 12], ['attack', 0], ['release', 0.25]]
          .forEach(([k, v]) => { if (comp[k] && comp[k].value !== undefined) comp[k].value = v; });
        osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
        const timer = setTimeout(() => resolve(null), 1500);
        ctx.oncomplete = ev => {
          clearTimeout(timer);
          try {
            const d = ev.renderedBuffer.getChannelData(0);
            let sum = 0;
            for (let i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
            resolve(sum.toFixed(6));
          } catch (e) { resolve(null); }
        };
        ctx.startRendering();
      } catch (e) { resolve(null); }
    });
  }

  // ── отправка ───────────────────────────────────────────────────
  async function collect() {
    const out = {};
    const g = glInfo();
    const put = async (k, v) => { if (v && String(v).length) out[k] = await sha(k + ':' + v); };
    if (g) { await put('gpu', g.gpu); await put('gl', g.gl); }
    await put('scr', screenInfo());
    await put('loc', locInfo());
    await put('fnt', fontsInfo());
    await put('cvs', canvasInfo());
    await put('aud', await audioInfo());
    return out;
  }

  let done = false;
  async function send() {
    if (done) return true;
    try {
      const s = await collect();
      if (!Object.keys(s).length) return true;
      const r = await fetch(API, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s }),
      });
      if (r.status === 401) return false;    // ещё не вошёл — попробуем позже
      done = r.ok || r.status === 429;
      return true;
    } catch (e) { return true; }
  }

  // Повторные попытки на случай, если вход выполнен уже после загрузки страницы.
  const delays = [3000, 60000, 300000];
  function attempt(i) {
    if (done || i >= delays.length) return;
    setTimeout(async () => {
      if (document.visibilityState === 'hidden' && i > 0) return attempt(i);
      const ok = await send();
      if (!ok) attempt(i + 1);
    }, delays[i]);
  }
  if (document.readyState === 'complete') attempt(0);
  else window.addEventListener('load', () => attempt(0), { once: true });
})();