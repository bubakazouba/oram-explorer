/* ORAM Explorer UI: plays the frames produced by sim-core.js */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const DEF = {
    optorama: { Ns: [8, 16, 32], N: 16 },
    megablocks: { Ns: [16, 32, 64], N: 32 },
  };
  const MAX_FRAMES = 9000;

  let mode = 'optorama';
  let sim = null;
  let T = [];          // timeline of frames
  let acc = [];        // accesses: {op,a,v,value,expected,ok,start,end,io,ioLookup,mem}
  let cur = -1;        // cursor into T
  let playing = false, timer = null;
  let ref = [];        // plain RAM reference
  let reveal = true;
  let initSnap = null, initClient = null;

  // ---------------- setup ----------------
  function fillN() {
    const sel = $('pN');
    sel.innerHTML = DEF[mode].Ns.map((n) => `<option ${n === DEF[mode].N ? 'selected' : ''}>${n}</option>`).join('');
    document.querySelectorAll('.mb-only').forEach((e) => e.classList.toggle('hidden', mode !== 'megablocks'));
  }
  function reset() {
    stop();
    const N = +$('pN').value, seed = +$('pSeed').value || 1;
    const opts = { N, seed };
    if (mode === 'megablocks') { opts.B = +$('pB').value; opts.g = +$('pG').value; }
    try { sim = OramSim.create(mode, opts); } catch (e) { alert(e.message); return; }
    ref = new Array(sim.N).fill(0);
    T = []; acc = []; cur = -1;
    initSnap = sim.snapshot();
    initClient = sim.clientView({});
    $('addr').max = sim.N - 1;
    if (+$('addr').value >= sim.N) $('addr').value = sim.N - 1;
    $('seqMsg').textContent = '';
    render();
  }

  // ---------------- issuing accesses ----------------
  function issue(op, a, v) {
    if (!(a >= 0 && a < sim.N)) { flash(`address must be 0..${sim.N - 1}`); return false; }
    const expected = ref[a];
    const res = sim.access(op, a, v);
    if (op === 'write') ref[a] = v;
    const start = T.length;
    let io = 0, ioL = 0;
    const id = acc.length;
    for (const f of res.frames) {
      io += f.trace.length;
      if (f.stage !== 'rebuild') ioL += f.trace.length;
      f.acc = id; f.cumIO = io;
      T.push(f);
    }
    acc.push({ op, a, v, value: res.value, expected, ok: res.value === expected, start, end: T.length - 1, io, ioL, foundAt: res.foundAt, mem: ref.slice() });
    trim();
    return true;
  }
  function trim() {
    if (T.length <= MAX_FRAMES) return;
    const k = T.length - MAX_FRAMES;
    T = T.slice(k);
    cur = Math.max(-1, cur - k);
    for (const x of acc) { x.start -= k; x.end -= k; }
  }
  function afterIssue(firstNew) {
    if (!playing) {
      if (cur < firstNew - 1) { /* user is reviewing older frames; leave cursor */ }
      else { cur = firstNew - 1; play(); }
    }
    render();
  }
  function flash(m) { $('seqMsg').textContent = m; }

  function parseSeq(text) {
    const out = [], re = /([rRwW])\s*(\d+)(?:\s*[=:,]\s*(-?\d+))?/g;
    let m;
    while ((m = re.exec(text))) {
      const op = m[1].toLowerCase() === 'w' ? 'write' : 'read';
      out.push({ op, a: +m[2], v: m[3] != null ? +m[3] : Math.floor(Math.random() * 100) });
    }
    return out;
  }

  // ---------------- playback ----------------
  function speedFps() { const s = +$('speed').value; return Math.round(0.5 * Math.pow(80, s / 100) * 10) / 10; }
  function play() {
    if (cur >= T.length - 1) { render(); return; }
    playing = true; $('play').textContent = 'Pause'; tick();
  }
  function stop() { playing = false; clearTimeout(timer); $('play').textContent = 'Play'; }
  function tick() {
    if (!playing) return;
    if (cur < T.length - 1) { cur++; render(); }
    if (cur >= T.length - 1) { stop(); render(); return; }
    timer = setTimeout(tick, 1000 / speedFps());
  }
  function step(d) { stop(); cur = Math.max(-1, Math.min(T.length - 1, cur + d)); render(); }
  function nextPhase() {
    stop();
    if (cur >= T.length - 1) return;
    const g = cur >= 0 ? T[cur].group : null, a = cur >= 0 ? T[cur].acc : null;
    let i = cur + 1;
    while (i < T.length - 1 && T[i].group === g && T[i].acc === a) i++;
    cur = i; render();
  }

  // ---------------- rendering helpers ----------------
  function cellHTML(x, cls, extraTitle) {
    if (!reveal) {
      return `<div class="c enc ${cls || ''}" title="encrypted${extraTitle ? ' · ' + esc(extraTitle) : ''}"></div>`;
    }
    if (!x) return `<div class="c ${cls || ''}" title="empty slot${extraTitle ? ' · ' + esc(extraTitle) : ''}"></div>`;
    if (x.a === undefined) return `<div class="c filler ${cls || ''}" title="dummy item${extraTitle ? ' · ' + esc(extraTitle) : ''}">&middot;</div>`;
    const t = `addr ${x.a}, value ${x.v}${x.d !== undefined ? ', destination bin ' + x.d : ''}${x.x ? ', excess (goes to overflow pile)' : ''}${extraTitle ? ' · ' + extraTitle : ''}`;
    return `<div class="c real ${x.x ? 'ex' : ''} ${cls || ''}" title="${esc(t)}"><b>${x.a}</b><i>${x.v}</i>${x.d !== undefined ? `<span class="d">&rarr;${x.d}</span>` : ''}</div>`;
  }
  function hlClass(h) {
    if (!h) return '';
    let c = 'hl-' + h.k;
    if (reveal) {
      if (h.swap) c += ' hl-sw';
      if (h.lab === 'dummy') c += ' hl-dummy';
      if (h.lab === 'hit') c += ' hl-hit';
    }
    return c;
  }
  function hlMap(frame) {
    const m = new Map();
    if (frame) for (const h of frame.hl) {
      const key = h.r + '|' + h.u;
      const prev = m.get(key);
      if (!prev) m.set(key, h);
      else m.set(key, Object.assign({}, prev, { k: prev.k === h.k ? h.k : 'rw', swap: prev.swap || h.swap, lab: prev.lab || h.lab }));
    }
    return m;
  }
  function regionHTML(r, hm) {
    const H = (u) => hlClass(hm.get(r.id + '|' + u));
    let body = '';
    if (r.layout === 'flat') {
      body = `<div class="cells">${r.units.map((x, i) => cellHTML(x, H(i), `${r.id}[${i}]`)).join('')}</div>`;
    } else if (r.layout === 'bins') {
      const parts = [];
      for (let b = 0; b < r.beta; b++) {
        const cells = [];
        for (let c = 0; c < r.m; c++) { const u = b * r.m + c; cells.push(cellHTML(r.units[u], H(u), `bin ${b}, cell ${c}`)); }
        parts.push(`<div class="bin"><div class="bl">bin ${b}</div><div class="cells">${cells.join('')}</div></div>`);
      }
      body = `<div class="cells" style="gap:0">${parts.join('')}</div>`;
    } else if (r.layout === 'varbins') {
      body = `<div class="varbins">${r.units.map((bin, b) => `<div class="bin"><div class="bl">bin ${b} (${bin.length})</div><div class="cells">${bin.map((x, k) => cellHTML(x, H(`${b}.${k}`), `staging bin ${b} slot ${k}`)).join('') || '<div class="c" style="opacity:.3"></div>'}</div></div>`).join('')}</div>`;
    } else if (r.layout === 'blocks') {
      body = `<div class="blocks">${r.units.map((blk, u) => blockHTML(blk, r.B, H(u), `${u}`)).join('')}</div>`;
    }
    return `<div class="reg"><div class="rt">${esc(r.id)}${r.title ? ' · ' + esc(r.title) : ''}</div>${body}</div>`;
  }
  function blockHTML(blk, B, cls, label, wide) {
    const cells = [];
    const n = Math.max(B, blk.length);
    for (let i = 0; i < n; i++) cells.push(cellHTML(blk[i] || null, '', ''));
    return `<div class="blk ${wide ? 'wide' : ''} ${cls}"><div class="bi">${esc(label)}</div><div class="cells">${cells.join('')}</div></div>`;
  }

  // ---------------- main render ----------------
  function render() {
    const f = cur >= 0 ? T[cur] : null;
    const snap = f ? f.snap : initSnap;
    const client = f ? f.client : initClient;
    const hm = hlMap(f);
    document.body.classList.toggle('rv', reveal);
    document.querySelectorAll('.rvOnly').forEach((e) => e.classList.toggle('hidden', !reveal));
    $('val').disabled = $('op').value !== 'write';

    // banner
    const chip = $('stageChip');
    if (!f) { chip.className = 'lookup'; chip.textContent = 'IDLE'; $('phase').textContent = acc.length ? 'Start of timeline' : 'Choose an operation and press Access'; }
    else { chip.className = f.stage === 'rebuild' ? 'rebuild' : 'lookup'; chip.textContent = f.stage === 'rebuild' ? 'REBUILD' : 'LOOKUP'; $('phase').textContent = f.phase; }
    if (f) {
      const A = acc[f.acc];
      $('frameInfo').innerHTML = `access #${f.acc} &middot; ${A.op}(${A.a}${A.op === 'write' ? ', ' + A.v : ''})<br>step ${cur - A.start + 1} / ${A.end - A.start + 1}${cur < T.length - 1 ? ` &middot; ${T.length - 1 - cur} queued` : ''}`;
    } else $('frameInfo').textContent = '';

    // server
    const lv = sim.levelInfo();
    const builtNow = f ? null : null;
    let html = '';
    for (const L of lv) {
      const regs = snap.filter((r) => r.kind === 'level' && r.level === L.level);
      const anyData = regs.some((r) => r.units.some((x) => (Array.isArray(x) ? x.length : x)));
      html += `<div class="lvl"><div class="lvlhead"><span class="name">${L.title}</span><span class="sub">${esc(L.sub)}</span>${L.level > 0 ? `<span class="tag ${anyData ? 'built' : ''}">${anyData ? 'holds items' : 'empty'}</span>` : ''}</div><div class="regions">${regs.map((r) => regionHTML(r, hm)).join('')}</div></div>`;
    }
    const scratch = snap.filter((r) => r.kind === 'scratch');
    if (scratch.length) html += `<div class="workspace"><div class="wt">Rebuild workspace (server memory used during the rebuild)</div><div class="regions" style="flex-direction:column">${scratch.map((r) => regionHTML(r, hm)).join('')}</div></div>`;
    $('serverBody').innerHTML = html;
    $('serverNote').textContent = reveal ? 'contents shown (god view)' : 'what the server sees: ciphertexts';

    // client
    renderClient(client, f, hm);

    // log
    if (f) {
      $('logNow').innerHTML = `<b>${esc(f.phase)}.</b> ${esc(f.log)}`;
      const A = acc[f.acc];
      const hist = [];
      for (let i = cur - 1; i >= Math.max(A.start, cur - 10); i--) hist.push(`<div><b>${esc(T[i].phase)}:</b> ${esc(T[i].log)}</div>`);
      $('logHist').innerHTML = hist.join('');
    } else { $('logNow').textContent = 'Pick read or write, an address, and press Access. Then step through it.'; $('logHist').innerHTML = ''; }

    renderHistory(f);
    renderMem(f);
    renderTrace(f);
    $('speedLbl').textContent = speedFps() + ' steps/s';
    $('back').disabled = cur < 0;
    $('step').disabled = $('nextPhase').disabled = $('toEnd').disabled = cur >= T.length - 1;
    $('play').disabled = cur >= T.length - 1 && !playing;
  }

  function renderClient(c, f, hm) {
    let h = `<div class="kv">${c.rows.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join('')}</div>`;
    h += `<div class="sec"><div class="t">PRF keys per level</div><div class="kv">${c.keys.map(([k, v]) => `<span class="k">${k}</span><span class="v">${reveal || v === '(empty)' ? v : v}</span>`).join('')}</div></div>`;
    if (c.held && c.held.length) {
      h += `<div class="sec"><div class="t">Holding right now</div><div class="held">${c.held.map((x) => `<span class="h"><span class="lbl">${esc(x.label)}</span>${x.item ? cellHTMLAlways(x.item) : `<b>${esc(x.text)}</b>`}</span>`).join('')}</div></div>`;
    }
    const w = c.work;
    if (w) {
      h += `<div class="sec"><div class="t">${esc(w.title)}</div>`;
      if (w.units) {
        h += `<div class="cells">${w.units.map((x, i) => cellHTMLAlways(x, hlClass(hm.get('__work|' + i)), `cell ${i}`)).join('')}</div>`;
      } else if (w.bits) {
        h += `<div class="bits">${w.bits.map((b) => `<span class="b${b}">${b}</span>`).join('')}</div>`;
      } else if (w.loads) {
        const mx = Math.max(...w.loads, ...w.secret, 1);
        h += `<div class="loads">${w.loads.map((l, b) => `<div class="lr"><span>bin ${b}</span><div><div class="bar" style="width:${(l / mx) * 100}%;background:var(--gold)" title="revealed load ${l}"></div><div class="bar" style="width:${(w.secret[b] / mx) * 100}%;background:var(--purple);margin-top:2px" title="secret load ${w.secret[b]}"></div></div></div>`).join('')}<div class="small"><span style="color:var(--gold)">revealed load</span> vs <span style="color:var(--purple)">secret load</span></div></div>`;
      } else if (w.block) {
        h += blockHTMLAlways(w.block, w.B);
      }
      h += '</div>';
    }
    $('clientBody').innerHTML = h;
  }
  // client memory is always readable by the client, so it ignores the "server's eyes" toggle
  function cellHTMLAlways(x, cls, t) { const r = reveal; reveal = true; const s = cellHTML(x, cls, t); reveal = r; return s; }
  function blockHTMLAlways(b, B) { const r = reveal; reveal = true; const s = blockHTML(b, B, '', `${b.length} word(s)`, B > 8); reveal = r; return s; }

  function renderHistory(f) {
    const curAcc = f ? f.acc : -1;
    const rows = [];
    for (let i = acc.length - 1; i >= 0 && rows.length < 60; i--) {
      const A = acc[i];
      const done = cur >= A.end;
      const inprog = f && f.acc === i && !done;
      if (!done && !inprog) continue;
      const res = done ? `${A.value}` : '...';
      const chk = done ? (A.ok ? '<span class="ok">ok</span>' : `<span class="bad">expected ${A.expected}</span>`) : '';
      rows.push(`<tr class="${i === curAcc ? 'cur' : ''}"><td>#${i}</td><td>${A.op === 'write' ? `w(${A.a},${A.v})` : `r(${A.a})`}</td><td>${res}</td><td>${chk}</td><td title="physical I/Os: lookup part + rebuild part">${A.ioL}${A.io > A.ioL ? '+' + (A.io - A.ioL) : ''}</td></tr>`);
    }
    $('history').innerHTML = rows.length ? `<table><tr><th>#</th><th>op</th><th>got</th><th>check</th><th>I/Os</th></tr>${rows.join('')}</table><div class="small" style="margin-top:4px">I/Os = lookup I/Os (+ rebuild I/Os). The lookup part is the same for every access at the same level fill state, whatever the address.</div>` : '<div class="small">No accesses yet.</div>';
  }
  function renderMem(f) {
    let mem = ref;
    if (f) { const A = acc[f.acc]; mem = cur >= A.end ? A.mem : (f.acc > 0 ? acc[f.acc - 1].mem : new Array(sim.N).fill(0)); }
    else if (acc.length) mem = new Array(sim.N).fill(0);
    $('mem').innerHTML = mem.map((v, a) => `<div><b>${a}</b>${v}</div>`).join('');
  }
  function renderTrace(f) {
    const box = $('trace');
    box.classList.toggle('rv', reveal);
    if (!f) { box.innerHTML = '<span class="small">The server sees only a list like this: which physical cell or block was read (R) or written (W), and in what order.</span>'; $('traceStats').textContent = ''; return; }
    const A = acc[f.acc];
    const all = [];
    for (let i = A.start; i <= cur; i++) for (const e of T[i].trace) all.push([e, i === cur]);
    const nR = all.filter(([e]) => e.op === 'R').length;
    const lim = 360;
    const shown = all.slice(-lim);
    const lab = (e) => (typeof e.u === 'string' ? `${e.r}[${e.u}]` : `${e.r}[${e.u}]`);
    box.innerHTML = (all.length > lim ? `<span class="small">${all.length - lim} earlier entries hidden &middot; </span>` : '') +
      shown.map(([e, isNew]) => `<span class="tc ${e.op} ${reveal ? e.lab || '' : ''} ${isNew ? 'new' : ''}" title="${reveal ? esc(e.lab || '') : 'no labels: the server cannot tell real from dummy'}">${esc(lab(e))}</span>`).join('');
    box.scrollTop = box.scrollHeight;
    $('traceStats').textContent = `${all.length} I/Os so far (${nR} R, ${all.length - nR} W) · this access in total: ${A.ioL} lookup + ${A.io - A.ioL} rebuild`;
  }

  // ---------------- wiring ----------------
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    const t = b.dataset.tab;
    $('about').classList.toggle('hidden', t !== 'about');
    $('simView').classList.toggle('hidden', t === 'about');
    $('params').classList.toggle('hidden', t === 'about');
    if (t !== 'about' && t !== mode) { mode = t; fillN(); reset(); }
  }));
  $('reset').addEventListener('click', reset);
  ['pN', 'pB', 'pG'].forEach((id) => $(id).addEventListener('change', reset));
  $('op').addEventListener('change', () => { $('val').disabled = $('op').value !== 'write'; });
  $('go').addEventListener('click', () => {
    const first = T.length;
    if (issue($('op').value, +$('addr').value, +$('val').value)) afterIssue(first);
  });
  $('rand').addEventListener('click', () => {
    const first = T.length;
    const op = Math.random() < 0.5 ? 'read' : 'write';
    const a = Math.floor(Math.random() * sim.N), v = Math.floor(Math.random() * 100);
    $('op').value = op; $('addr').value = a; $('val').value = v;
    if (issue(op, a, v)) afterIssue(first);
  });
  $('preset').addEventListener('change', () => {
    const p = $('preset').value, N = sim.N;
    const r = () => Math.floor(Math.random() * N);
    if (p === 'wr') $('seq').value = `w${r()}=11 w${r()}=22 w${r()}=33 r0 r1 r2 r3`;
    if (p === 'scan') $('seq').value = Array.from({ length: N }, (_, i) => `r${i}`).join(' ');
    if (p === 'hot') $('seq').value = Array.from({ length: 12 }, (_, i) => (i % 3 ? 'r0' : `w0=${i}`)).join(' ');
    if (p === 'rand') $('seq').value = Array.from({ length: 10 }, () => (Math.random() < 0.5 ? `r${r()}` : `w${r()}=${Math.floor(Math.random() * 100)}`)).join(' ');
    $('preset').value = '';
  });
  $('runSeq').addEventListener('click', () => {
    const ops = parseSeq($('seq').value);
    if (!ops.length) { flash('nothing to run'); return; }
    if (ops.length > 80) { flash('max 80 operations at a time'); return; }
    const bad = ops.find((o) => o.a >= sim.N);
    if (bad) { flash(`address ${bad.a} is out of range 0..${sim.N - 1}`); return; }
    const first = T.length;
    for (const o of ops) issue(o.op, o.a, o.v);
    flash(`queued ${ops.length} accesses`);
    afterIssue(first);
  });
  $('play').addEventListener('click', () => (playing ? stop() : play()));
  $('step').addEventListener('click', () => step(1));
  $('back').addEventListener('click', () => step(-1));
  $('nextPhase').addEventListener('click', nextPhase);
  $('toEnd').addEventListener('click', () => { stop(); cur = T.length - 1; render(); });
  $('speed').addEventListener('input', () => { $('speedLbl').textContent = speedFps() + ' steps/s'; });
  $('reveal').addEventListener('change', () => { reveal = $('reveal').checked; render(); });
  document.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(); }
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'n' || e.key === 'N') nextPhase();
    else if (e.key === 'e' || e.key === 'E') { stop(); cur = T.length - 1; render(); }
  });

  fillN();
  reset();
})();
