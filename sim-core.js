/* ORAM Explorer simulation core.
 * Real (toy-sized) implementations of a hierarchical OptORAMa-style ORAM and a
 * MegaBlocks-style ORAM. Every logical access is compiled into a list of frames;
 * each frame records the phase, a one-sentence explanation, the physical I/Os the
 * server observes (trace), highlights, and a snapshot of server + client state.
 * Works in the browser (window.OramSim) and in node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OramSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- randomness and PRF ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mix(h, x) {
    h = (h ^ (x >>> 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  // Toy PRF: keyed integer hash. Stands in for AES/HMAC.
  function prf(key) {
    let h = mix(0x9e3779b9, key);
    for (let i = 1; i < arguments.length; i++) h = mix((h + 0x9e3779b9) >>> 0, arguments[i]);
    return h >>> 0;
  }
  const hex = (k) => (k >>> 0).toString(16).padStart(8, '0').slice(0, 4);
  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
  function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

  // ---------- fixed (data independent) compaction network ----------
  // Batcher odd-even merge sort comparators, grouped into parallel stages.
  function batcherStages(n) {
    const P = nextPow2(n), stages = [];
    for (let p = 1; p < P; p <<= 1) {
      for (let k = p; k >= 1; k >>= 1) {
        const st = [];
        for (let j = k % p; j <= P - 1 - k; j += 2 * k) {
          for (let i = 0; i <= Math.min(k - 1, P - j - k - 1); i++) {
            if (Math.floor((i + j) / (2 * p)) === Math.floor((i + j + k) / (2 * p))) {
              const x = i + j, y = i + j + k;
              if (y < n) st.push([x, y]); // virtual padding slots never swap, so drop them
            }
          }
        }
        if (st.length) stages.push(st);
      }
    }
    return stages;
  }
  // Expander-like rounds: fixed perfect matchings between the front half and the back half.
  function expanderStages(n, rounds) {
    rounds = rounds || 3;
    if (n < 4) return [];
    const h = Math.floor(n / 2), stages = [];
    const mults = [];
    for (let a = 1; mults.length < rounds; a += 2) if (gcd(a, h) === 1 || h === 1) mults.push(a);
    const offs = [0, 1, 3, 5, 7];
    for (let r = 0; r < rounds; r++) {
      const st = [];
      for (let i = 0; i < h; i++) st.push([i, h + ((mults[r] * i + offs[r]) % h)]);
      stages.push(st);
    }
    return stages;
  }
  const _stageCache = new Map();
  function compactionStages(n) {
    if (!_stageCache.has(n)) _stageCache.set(n, { exp: expanderStages(n), bat: batcherStages(n) });
    return _stageCache.get(n);
  }

  function shuffleInPlace(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rnd(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Items are immutable: {a, v} real item; {f:1} filler/dummy item; null empty (encrypted dummy) slot.
  const isReal = (x) => !!x && x.a !== undefined;
  const FILLER = Object.freeze({ f: 1 });

  // ======================================================================
  class Base {
    constructor(seed) {
      this.seed = seed >>> 0;
      this.rng = mulberry32(this.seed || 1);
      this.regions = [];
      this.frames = null;
      this.snapshots = true;
      this.t = 0;
      this.curAccess = -1;
    }
    rnd(n) { return Math.floor(this.rng() * n); }
    newKey() { return (Math.floor(this.rng() * 4294967296) >>> 0) || 1; }
    R(id) {
      const r = this.regions.find((x) => x.id === id);
      if (!r) throw new Error('no region ' + id);
      return r;
    }
    addRegion(r) {
      r.units = r.units || [];
      this.regions.push(r);
      return r;
    }
    dropRegion(id) { this.regions = this.regions.filter((r) => r.id !== id); }
    snapshot() {
      return this.regions.map((r) => Object.assign({}, r, { units: r.units.slice() }));
    }
    emit(phase, log, o) {
      if (!this.frames) return;
      o = o || {};
      this.frames.push({
        phase,
        group: o.group || phase,
        stage: o.stage || 'lookup',
        log,
        hl: o.hl || [],
        trace: o.trace || [],
        snap: this.snapshots ? this.snapshot() : null,
        client: this.snapshots ? this.clientView(o.cl || {}) : null,
        access: this.curAccess,
      });
    }
    // read+write every unit in a list, returning trace + highlights
    rwAll(regId, units, lab, k) {
      const tr = [], hl = [];
      for (const u of units) {
        if (k !== 'write') tr.push({ op: 'R', r: regId, u, lab });
      }
      for (const u of units) {
        if (k !== 'read') tr.push({ op: 'W', r: regId, u, lab });
        hl.push({ r: regId, u, k: k || 'rw', lab });
      }
      return { tr, hl };
    }
    range(n) { return Array.from({ length: n }, (_, i) => i); }

    // Run the fixed compaction network on a region (unit = cell or block), with frames.
    compactRegion(regId, marked, title, group, what) {
      const reg = this.R(regId);
      const n = reg.units.length;
      const { exp, bat } = compactionStages(n);
      const k = reg.units.filter(marked).length;
      const cnt = this.rwAll(regId, this.range(n), 'build', 'read');
      this.emit(`${title}: count marked`,
        `Tight compaction starts with one linear pass: the client reads all ${n} slots and privately counts the marked ones (${what}, k = ${k}). The pass is the same for any data.`,
        { stage: 'rebuild', group, trace: cnt.tr, hl: cnt.hl });
      const runStage = (pairs, phase, log) => {
        const hl = [], tr = [];
        let nsw = 0;
        for (const [i, j] of pairs) {
          const sw = !marked(reg.units[i]) && marked(reg.units[j]);
          if (sw) { const tmp = reg.units[i]; reg.units[i] = reg.units[j]; reg.units[j] = tmp; nsw++; }
          tr.push({ op: 'R', r: regId, u: i, lab: 'build' }, { op: 'R', r: regId, u: j, lab: 'build' },
            { op: 'W', r: regId, u: i, lab: 'build' }, { op: 'W', r: regId, u: j, lab: 'build' });
          hl.push({ r: regId, u: i, k: 'rw', swap: sw }, { r: regId, u: j, k: 'rw', swap: sw });
        }
        this.emit(phase, log.replace('#S', nsw), { stage: 'rebuild', group, trace: tr, hl });
      };
      exp.forEach((pairs, r) => runStage(pairs,
        `${title}: expander swap round ${r + 1}/${exp.length}`,
        `Expander round ${r + 1}: along ${pairs.length} fixed edges (front-half slot, back-half slot) the client reads both ends and swaps if an unmarked item sits in front and a marked one behind. #S real swaps; every edge is read and rewritten, so the server cannot tell which.`));
      bat.forEach((pairs, s) => runStage(pairs,
        `${title}: finishing network stage ${s + 1}/${bat.length}`,
        `Finishing stage ${s + 1}: fixed compare-exchange pairs push any remaining marked items forward (#S swaps). This stands in for the paper's loose compaction + recursion.`));
      for (let i = 0; i < n; i++) {
        if ((i < k) !== !!marked(reg.units[i])) throw new Error('compaction failed in ' + regId);
      }
      return k;
    }
  }

  // ======================================================================
  //                              OptORAMa
  // ======================================================================
  class OptORAMa extends Base {
    constructor(opts) {
      opts = opts || {};
      super(opts.seed == null ? 7 : opts.seed);
      this.mode = 'optorama';
      this.N = opts.N || 16;
      if (this.N < 8 || (this.N & (this.N - 1))) throw new Error('N must be a power of 2, at least 8');
      this.cap0 = 4;
      this.caps = [this.cap0];
      for (let c = this.cap0; c <= this.N; c *= 2) this.caps.push(c);
      this.L = this.caps.length - 1;
      this.lp = [null];
      this.lv = [{ built: true }];
      this.addRegion({ id: 'L0', level: 0, kind: 'level', title: 'Level 0 · linear-scan buffer', layout: 'flat', units: new Array(this.cap0).fill(null) });
      for (let l = 1; l <= this.L; l++) {
        const n = this.caps[l];
        const beta = Math.max(1, n / 4);
        const m = 8;
        const O = Math.max(2, n / 4);
        const p = { n, beta, m, O, mo: 2 * O, S: 3, nPrime: n - Math.max(1, n / 8) };
        this.lp.push(p);
        this.lv.push({ built: false, key: 0, binSeeds: [], ovfSeed: 0 });
        this.addRegion({ id: `L${l}.bins`, level: l, kind: 'level', title: `bins (${beta} × Cuckoo table of ${m})`, layout: 'bins', beta, m, units: new Array(beta * m).fill(null) });
        this.addRegion({ id: `L${l}.ovf`, level: l, kind: 'level', title: `overflow pile Cuckoo (${2 * O})`, layout: 'flat', units: new Array(2 * O).fill(null) });
        this.addRegion({ id: `L${l}.stash`, level: l, kind: 'level', title: `combined stash (${p.S})`, layout: 'flat', units: new Array(p.S).fill(null) });
      }
      // initial state: all N addresses (value 0) live in the largest level
      const saved = this.frames;
      this.frames = null;
      const init = shuffleInPlace(this.range(this.N).map((a) => ({ a, v: 0 })), (k) => this.rnd(k));
      this.addRegion({ id: 'MIX', kind: 'scratch', title: 'input', layout: 'flat', units: init });
      this.buildLevel(this.L, 'MIX');
      this.dropRegion('MIX');
      this.frames = saved;
    }

    levelInfo() {
      const out = [{ level: 0, title: 'Level 0', sub: `scan buffer · ${this.cap0} slots`, built: true }];
      for (let l = 1; l <= this.L; l++) {
        const p = this.lp[l];
        out.push({ level: l, title: `Level ${l}`, sub: `capacity ${p.n} · ${p.beta} bin${p.beta > 1 ? 's' : ''}${l === this.L ? ' · largest' : ''}`, built: this.lv[l].built });
      }
      return out;
    }

    clientView(extra) {
      const keys = [];
      for (let l = 1; l <= this.L; l++) keys.push([`L${l}`, this.lv[l].built ? hex(this.lv[l].key) : '(empty)']);
      const nextR = (Math.floor(this.t / this.cap0) + 1) * this.cap0;
      return {
        rows: [
          ['accesses done (t)', String(this.t)],
          ['next rebuild after access', String(nextR)],
          ['full levels', this.lv.map((x, l) => (l > 0 && x.built ? l : null)).filter((x) => x !== null).join(', ') || 'none'],
        ],
        keys,
        held: extra.held || [],
        work: extra.work || null,
        note: extra.note || '',
      };
    }

    cuckooPos(seed, a, m) {
      const h1 = prf(seed, a, 1) % m;
      const h2 = (h1 + 1 + (prf(seed, a, 2) % (m - 1))) % m;
      return [h1, h2];
    }
    randPair(m) {
      const h1 = this.rnd(m);
      const h2 = (h1 + 1 + this.rnd(m - 1)) % m;
      return [h1, h2];
    }

    access(op, a, val) {
      a = a | 0;
      if (a < 0 || a >= this.N) throw new Error('address out of range');
      this.frames = [];
      this.curAccess = this.t;
      const held = [];
      this.emit('Access requested', `You asked to ${op === 'write' ? `write ${val} to` : 'read'} address ${a}. Everything below is what that request compiles into.`,
        { cl: { held: [{ label: 'request', text: op === 'write' ? `write(${a}, ${val})` : `read(${a})` }] } });

      // Level 0: linear scan
      const L0 = this.R('L0');
      let found = null, foundAt = -1, fIdx = -1;
      for (let i = 0; i < L0.units.length; i++) {
        const it = L0.units[i];
        if (isReal(it) && it.a === a) { found = it; foundAt = 0; fIdx = i; L0.units[i] = null; }
      }
      const s0 = this.rwAll('L0', this.range(this.cap0), 'scan');
      s0.hl.forEach((h) => { if (h.u === fIdx) h.lab = 'hit'; });
      if (found) held.push({ label: 'found', item: found });
      this.emit('Lookup level 0 (scan)', found
        ? `Level 0 is tiny, so the client reads and rewrites all ${this.cap0} slots. Address ${a} is here (value ${found.v}); its old slot is rewritten empty.`
        : `Level 0 is tiny, so the client reads and rewrites all ${this.cap0} slots. Address ${a} is not here; the server sees the same full scan either way.`,
        { trace: s0.tr, hl: s0.hl, group: 'Lookup', cl: { held: held.slice() } });

      for (let l = 1; l <= this.L; l++) {
        if (!this.lv[l].built) continue; // empty level: skipped by schedule, independent of data
        const got = this.lookupLevel(l, a, !found, held);
        if (got) { found = got; foundAt = l; held.push({ label: 'found', item: got }); }
      }
      if (!found) throw new Error('item lost: ' + a);
      const oldV = found.v;
      const nv = op === 'write' ? (val | 0) : oldV;
      const item = { a, v: nv };
      const slot = this.t % this.cap0;
      L0.units[slot] = item;
      this.emit('Write-back to level 0', `The client writes (addr ${a}, value ${nv}) into level 0 slot ${slot}. It was found in level ${foundAt}; moving it up means no level ever sees the same lookup twice.`,
        { trace: [{ op: 'W', r: 'L0', u: slot, lab: 'real' }], hl: [{ r: 'L0', u: slot, k: 'write', lab: 'real' }], group: 'Write-back',
          cl: { held: [{ label: op === 'read' ? 'returned value' : 'old value', text: String(oldV) }, { label: 'writing', item }] } });
      this.t++;
      if (this.t % this.cap0 === 0) this.rebuild();
      const frames = this.frames;
      this.frames = null;
      return { value: oldV, foundAt, frames };
    }

    lookupLevel(l, a, real, held) {
      const lv = this.lv[l], p = this.lp[l];
      let got = null;
      const grp = `Lookup level ${l}`;
      // 1. combined stash scan
      const st = this.R(`L${l}.stash`);
      let hitU = -1;
      if (real) {
        for (let i = 0; i < st.units.length; i++) if (isReal(st.units[i]) && st.units[i].a === a) { got = st.units[i]; st.units[i] = null; hitU = i; }
      }
      const s = this.rwAll(st.id, this.range(p.S), 'scan');
      if (hitU >= 0) s.hl[hitU].lab = 'hit';
      this.emit(`${real ? 'Lookup' : 'Dummy lookup'} level ${l}: scan combined stash`,
        got ? `The combined stash of level ${l} is scanned in full (${p.S} slots). Address ${a} was in the stash; it is removed.`
          : `The combined stash of level ${l} is small, so all ${p.S} slots are read and rewritten every time.${real ? '' : ' (Item already found: this is just part of the fixed pattern.)'}`,
        { trace: s.tr, hl: s.hl, group: grp, cl: { held: held.concat(got ? [{ label: 'found', item: got }] : []) } });
      // 2. overflow pile Cuckoo table
      const ov = this.R(`L${l}.ovf`);
      let pos, lab;
      if (real && !got) { pos = this.cuckooPos(lv.ovfSeed, a, p.mo); lab = 'real'; } else { pos = this.randPair(p.mo); lab = 'dummy'; }
      let hitHere = -1;
      if (lab === 'real') for (const c of pos) if (isReal(ov.units[c]) && ov.units[c].a === a) { got = ov.units[c]; ov.units[c] = null; hitHere = c; }
      let r = this.rwAll(ov.id, pos, lab);
      r.hl.forEach((h) => { if (h.u === hitHere) h.lab = 'hit'; });
      this.emit(`${lab === 'real' ? 'Lookup' : 'Dummy lookup'} level ${l}: overflow pile`,
        lab === 'real'
          ? `Overflow pile: client evaluates its Cuckoo hashes for address ${a} -> cells ${pos[0]} and ${pos[1]}, reads both, rewrites both.${hitHere >= 0 ? ' Found it here.' : ' Not here.'}`
          : `Overflow pile: ${got ? 'item already found, so the' : 'the'} client probes 2 uniformly random cells (${pos[0]}, ${pos[1]}). To the server this looks exactly like a real probe.`,
        { trace: r.tr, hl: r.hl, group: grp, cl: { held: held.concat(got ? [{ label: 'found', item: got }] : []) } });
      // 3. one bin's Cuckoo table
      const bins = this.R(`L${l}.bins`);
      let b;
      if (real && !got) { b = prf(lv.key, a) % p.beta; pos = this.cuckooPos(lv.binSeeds[b], a, p.m); lab = 'real'; }
      else { b = this.rnd(p.beta); pos = this.randPair(p.m); lab = 'dummy'; }
      const units = pos.map((c) => b * p.m + c);
      hitHere = -1;
      if (lab === 'real') for (const u of units) if (isReal(bins.units[u]) && bins.units[u].a === a) { got = bins.units[u]; bins.units[u] = null; hitHere = u; }
      r = this.rwAll(bins.id, units, lab);
      r.hl.forEach((h) => { if (h.u === hitHere) h.lab = 'hit'; });
      this.emit(`${lab === 'real' ? 'Lookup' : 'Dummy lookup'} level ${l}: bin ${b}`,
        lab === 'real'
          ? `Bin = PRF_key${l}(${a}) mod ${p.beta} = ${b}. Inside that bin's Cuckoo table, address ${a} can only be in cell ${pos[0]} or ${pos[1]}: read both, rewrite both.${hitHere >= 0 ? ` Found (value ${got.v}); the cell is rewritten empty.` : ' Not in this level.'}`
          : `Dummy: random bin ${b}, random cells ${pos[0]} and ${pos[1]}. Each address is looked up at most once per level between rebuilds, so real probes are also fresh random-looking positions.`,
        { trace: r.tr, hl: r.hl, group: grp, cl: { held: held.concat(got ? [{ label: 'found', item: got }] : []) } });
      return got;
    }

    // ---------------- rebuild ----------------
    rebuild() {
      let j = -1;
      for (let l = 1; l < this.L; l++) if (!this.lv[l].built) { j = l; break; }
      if (j < 0) j = this.L;
      const srcs = [];
      for (let l = 0; l < j; l++) srcs.push(l);
      if (j === this.L) srcs.push(this.L);
      this.emit(`Rebuild level ${j}`,
        `Level 0 filled up (every ${this.cap0} accesses). Like a binary counter, levels ${srcs.join(', ')} are merged into a fresh level ${j}. The schedule depends only on the access count t, never on addresses.`,
        { stage: 'rebuild', group: `Rebuild level ${j}` });
      const xs = [];
      for (const l of srcs) xs.push(l === 0 ? this.extractL0() : this.extractLevel(l));
      // intersperse
      let cur = xs[0];
      for (let i = 1; i < xs.length; i++) cur = this.intersperse(cur, xs[i], i === xs.length - 1 ? 'MIX' : `MIX${i}`);
      if (cur !== 'MIX') { this.R(cur).id = 'MIX'; }
      if (j === this.L) {
        const tot = this.R('MIX').units.length;
        this.compactRegion('MIX', isReal, `Rebuild L${j}: compact the merged array`, `Compact merged array`, 'real items');
        const mix = this.R('MIX');
        mix.units = mix.units.slice(0, this.N);
        this.emit(`Rebuild L${j}: truncate to N`, `All ${this.N} real items now sit in the first ${this.N} of ${tot} slots; the tail (only fillers) is dropped.`,
          { stage: 'rebuild', group: 'Compact merged array' });
      }
      for (const l of srcs) if (l !== j) this.clearLevel(l);
      this.buildLevel(j, 'MIX');
      this.dropRegion('MIX');
      this.emit(`Level ${j} rebuilt`, `Level ${j} now holds every unread item from the merged levels, under a fresh PRF key${j > 1 ? `; levels ${srcs.filter((x) => x !== j).join(', ')} are empty` : ''}. Lookups resume.`,
        { stage: 'rebuild', group: `Done` });
    }

    clearLevel(l) {
      if (l === 0) { this.R('L0').units = new Array(this.cap0).fill(null); return; }
      for (const s of ['bins', 'ovf', 'stash']) { const r = this.R(`L${l}.${s}`); r.units = new Array(r.units.length).fill(null); }
      this.lv[l].built = false;
    }

    extractL0() {
      const L0 = this.R('L0');
      const items = L0.units.map((x) => (isReal(x) ? x : FILLER));
      shuffleInPlace(items, (k) => this.rnd(k));
      this.addRegion({ id: 'X0', kind: 'scratch', title: 'extracted level 0', layout: 'flat', units: items });
      const rd = this.rwAll('L0', this.range(this.cap0), 'build', 'read');
      const wr = this.rwAll('X0', this.range(this.cap0), 'build', 'write');
      this.emit('Rebuild: extract level 0', `The client reads all ${this.cap0} level-0 slots into private memory, shuffles them with a secret permutation, and writes them to the workspace (empty slots become dummy items).`,
        { stage: 'rebuild', group: 'Extract', trace: rd.tr.concat(wr.tr), hl: rd.hl.concat(wr.hl), cl: { work: { title: 'shuffled level 0 (private)', units: items } } });
      return 'X0';
    }

    extractLevel(l) {
      const p = this.lp[l];
      const parts = ['bins', 'ovf', 'stash'].map((s) => this.R(`L${l}.${s}`));
      const all = [].concat(...parts.map((r) => r.units));
      const id = `X${l}`;
      this.addRegion({ id, kind: 'scratch', title: `extracted level ${l}`, layout: 'flat', units: all.slice() });
      let tr = [], hl = [];
      for (const r of parts) { const x = this.rwAll(r.id, this.range(r.units.length), 'build', 'read'); tr = tr.concat(x.tr); hl = hl.concat(x.hl); }
      const w = this.rwAll(id, this.range(all.length), 'build', 'write');
      this.emit(`Rebuild: extract level ${l}: copy`, `Extract level ${l}: copy all ${all.length} physical cells (bins, overflow pile, stash) into the workspace. Unread real items are mixed with empty cells and with holes left by earlier lookups.`,
        { stage: 'rebuild', group: `Extract level ${l}`, trace: tr.concat(w.tr), hl: hl.concat(w.hl) });
      this.compactRegion(id, isReal, `Extract level ${l}: tight compaction`, `Extract level ${l}`, 'unread real items');
      const reg = this.R(id);
      reg.units = reg.units.slice(0, p.n).map((x) => (isReal(x) ? x : FILLER));
      this.emit(`Extract level ${l}: truncate`, `Keep the first ${p.n} slots (the level's capacity); every unread real item is among them. Holes become dummy items. Unvisited items keep the hidden random order the level was built with.`,
        { stage: 'rebuild', group: `Extract level ${l}` });
      return id;
    }

    intersperse(idA, idB, outId) {
      const A = this.R(idA).units, B = this.R(idB).units;
      const n0 = A.length, n1 = B.length, n = n0 + n1;
      const bits = shuffleInPlace(new Array(n0).fill(0).concat(new Array(n1).fill(1)), (k) => this.rnd(k));
      // privately run the compaction network on the bit string (mark = 0) and record swap decisions
      const { exp, bat } = compactionStages(n);
      const stages = exp.concat(bat);
      const v = bits.slice();
      const rec = stages.map((pairs) => pairs.map(([i, j]) => {
        const sw = v[i] !== 0 && v[j] === 0;
        if (sw) { v[i] = 0; v[j] = 1; }
        return sw;
      }));
      this.dropRegion(idA); this.dropRegion(idB);
      const mix = this.addRegion({ id: outId, kind: 'scratch', title: 'interspersed', layout: 'flat', units: A.concat(B) });
      this.emit('Intersperse: sample secret bit string', `To merge ${n0} + ${n1} shuffled items into one uniformly shuffled array, the client samples a random string with ${n0} zeros and ${n1} ones: zeros will receive the first array, ones the second.`,
        { stage: 'rebuild', group: 'Intersperse', cl: { work: { title: 'secret bit string (private)', bits } } });
      for (let s = stages.length - 1; s >= 0; s--) {
        const hl = [], tr = [];
        let nsw = 0;
        stages[s].forEach(([i, j], q) => {
          const sw = rec[s][q];
          if (sw) { const tmp = mix.units[i]; mix.units[i] = mix.units[j]; mix.units[j] = tmp; nsw++; }
          tr.push({ op: 'R', r: outId, u: i, lab: 'build' }, { op: 'R', r: outId, u: j, lab: 'build' }, { op: 'W', r: outId, u: i, lab: 'build' }, { op: 'W', r: outId, u: j, lab: 'build' });
          hl.push({ r: outId, u: i, k: 'rw', swap: sw }, { r: outId, u: j, k: 'rw', swap: sw });
        });
        this.emit(`Intersperse: reverse compaction stage ${stages.length - s}/${stages.length}`,
          `Tight compaction run backwards: replaying the recorded swaps of the bit-string compaction in reverse moves each item into a slot whose bit says where it belongs (${nsw} swaps this stage, hidden behind fixed read/write pairs).`,
          { stage: 'rebuild', group: 'Intersperse', trace: tr, hl, cl: { work: { title: 'secret bit string (private)', bits } } });
      }
      // sanity: slot i holds an element of A iff bits[i] == 0
      const setA = new Set(A);
      mix.units.forEach((x, i) => { if (isReal(x) && setA.has(x) !== (bits[i] === 0)) throw new Error('intersperse failed'); });
      return outId;
    }

    // Build level j's hash table from region inId (size = caps[j]).
    buildLevel(j, inId) {
      const p = this.lp[j], lv = this.lv[j];
      const D = this.R(inId).units;
      if (D.length !== p.n) throw new Error(`build L${j}: got ${D.length} items, expected ${p.n}`);
      // ---------- private planning (no server I/O) ----------
      lv.key = this.newKey();
      const bins = Array.from({ length: p.beta }, () => []);
      const placeLog = [];
      D.forEach((x, i) => {
        const b = isReal(x) ? prf(lv.key, x.a) % p.beta : this.rnd(p.beta);
        placeLog.push([i, b, bins[b].length]);
        bins[b].push(x);
      });
      const loads = bins.map((b) => b.length);
      let Lp, excess, tries = 0;
      for (;;) {
        tries++;
        Lp = new Array(p.beta).fill(0);
        for (let i = 0; i < p.nPrime; i++) Lp[this.rnd(p.beta)]++;
        excess = [];
        bins.forEach((bin, b) => bin.forEach((x, k) => { if (k >= Lp[b] && isReal(x)) excess.push(x); }));
        if (excess.length <= p.O) break;
        if (tries > 5000) throw new Error('secret loads: overflow pile too small');
      }
      const kept = bins.map((bin, b) => bin.slice(0, Lp[b]).filter(isReal));
      // Cuckoo tables (retry seeds privately until the combined stash fits)
      let plan;
      for (let attempt = 0; ; attempt++) {
        if (attempt > 5000) throw new Error('cuckoo: stash overflow');
        const seeds = bins.map(() => this.newKey());
        const ovfSeed = this.newKey();
        const binTabs = kept.map((items, b) => this.cuckooBuild(items, seeds[b], p.m));
        const ovfTab = this.cuckooBuild(excess, ovfSeed, p.mo);
        const stash = [].concat(...binTabs.map((t) => t.stash), ovfTab.stash);
        if (stash.length <= p.S) { plan = { seeds, ovfSeed, binTabs, ovfTab, stash }; break; }
      }
      const G = `Build level ${j}`;
      // ---------- 1. PRF binning in the clear ----------
      const BIN = this.addRegion({ id: 'BIN', kind: 'scratch', title: `PRF bins (loads revealed)`, layout: 'varbins', units: bins.map(() => []) });
      const chunk = D.length <= 8 ? 1 : 4;
      for (let s = 0; s < placeLog.length; s += chunk) {
        const tr = [], hl = [], msgs = [];
        for (const [i, b, k] of placeLog.slice(s, s + chunk)) {
          const x = D[i];
          BIN.units[b] = BIN.units[b].concat([x]);
          tr.push({ op: 'R', r: inId, u: i, lab: 'build' }, { op: 'W', r: 'BIN', u: `${b}.${k}`, lab: 'build' });
          hl.push({ r: inId, u: i, k: 'read' }, { r: 'BIN', u: `${b}.${k}`, k: 'write' });
          msgs.push(isReal(x) ? `addr ${x.a} -> bin ${b}` : `dummy -> bin ${b}`);
        }
        this.emit(`Build L${j}: PRF binning (in the clear)`,
          `${msgs.join(', ')}. Real items go to bin PRF_key${j}(addr) mod ${p.beta}, dummies to a random bin. The server sees which bin each write lands in, which is safe only because the input is already secretly shuffled.`,
          { stage: 'rebuild', group: `${G}: binning`, trace: tr, hl });
      }
      // ---------- 2. secret loads ----------
      this.emit(`Build L${j}: sample secret loads`,
        `Revealed loads are [${loads.join(', ')}]. The client privately samples fresh loads [${Lp.join(', ')}] by throwing ${p.nPrime} < ${p.n} balls into ${p.beta} bins. Each bin will keep only that many items; the rest go to the overflow pile. The secret loads are never revealed, which masks later lookups.`,
        { stage: 'rebuild', group: `${G}: secret loads`, cl: { work: { title: 'revealed vs secret loads (private)', loads, secret: Lp } } });
      // mark excess and compact them out into the overflow staging array
      const flat = [], back = [];
      BIN.units = BIN.units.map((bin, b) => bin.map((x, k) => {
        const y = (k >= Lp[b] && isReal(x)) ? Object.freeze({ a: x.a, v: x.v, x: 1 }) : x;
        flat.push(y); back.push(`${b}.${k}`);
        return y;
      }));
      const exc = this.addRegion({ id: 'EXC', kind: 'scratch', title: 'excess copy', layout: 'flat', units: flat.slice() });
      const rd = back.map((u) => ({ op: 'R', r: 'BIN', u, lab: 'build' }));
      const wr = flat.map((_, i) => ({ op: 'W', r: 'EXC', u: i, lab: 'build' }));
      this.emit(`Build L${j}: secret load + move excess to overflow`,
        `The client marks every real item beyond its bin's secret load (${excess.length} items, struck through) and copies all bins into a scratch array. Marking happens inside encrypted cells, so the server learns nothing.`,
        { stage: 'rebuild', group: `${G}: overflow`, trace: rd.concat(wr), hl: back.map((u) => ({ r: 'BIN', u, k: 'read' })).concat(flat.map((_, i) => ({ r: 'EXC', u: i, k: 'write' }))) });
      this.compactRegion('EXC', (x) => !!x && x.x === 1, `Build L${j}: compact excess to front`, `${G}: overflow`, 'excess items');
      exc.units = exc.units.slice(0, p.O).map((x) => (x && x.x === 1 ? x : null));
      exc.id = 'OVS'; exc.title = 'overflow pile (staged)';
      this.emit(`Build L${j}: overflow pile staged`, `The first ${p.O} slots now hold all ${excess.length} excess items (padded with empties). This becomes the overflow pile, which gets its own Cuckoo table.`,
        { stage: 'rebuild', group: `${G}: overflow` });
      // ---------- 3. per-bin Cuckoo tables ----------
      const binsReg = this.R(`L${j}.bins`), ovReg = this.R(`L${j}.ovf`), stReg = this.R(`L${j}.stash`);
      binsReg.units = new Array(p.beta * p.m).fill(null);
      ovReg.units = new Array(p.mo).fill(null);
      stReg.units = new Array(p.S).fill(null);
      const stashSoFar = [];
      const cuckooFrames = (tab, title, grp) => {
        const work = new Array(tab.size).fill(null);
        for (const step of tab.steps) {
          for (const [c, x] of step.writes) work[c] = x;
          this.emit(`${title}: Cuckoo insert`, step.msg,
            { stage: 'rebuild', group: grp, hl: step.writes.map(([c]) => ({ r: '__work', u: c, k: 'swap' })),
              cl: { work: { title: `${title} Cuckoo table (private, being built)`, units: work.slice() }, held: stashSoFar.map((x) => ({ label: 'stash', item: x })) } });
        }
        for (const x of tab.stash) stashSoFar.push(x);
        return work;
      };
      bins.forEach((bin, b) => {
        const tab = plan.binTabs[b];
        const units = bin.map((_, k) => `${b}.${k}`);
        this.emit(`Build L${j}: bin ${b}: read into client`,
          `Read bin ${b} (${bin.length} items) into private memory. The client keeps the ${kept[b].length} real items within the secret load and ignores the struck-through excess (already copied to the overflow pile).`,
          { stage: 'rebuild', group: `${G}: bin ${b}`, trace: units.map((u) => ({ op: 'R', r: 'BIN', u, lab: 'build' })), hl: units.map((u) => ({ r: 'BIN', u, k: 'read' })),
            cl: { held: kept[b].map((x) => ({ label: 'to insert', item: x })) } });
        const work = cuckooFrames(tab, `bin ${b}`, `${G}: bin ${b}`);
        for (let c = 0; c < p.m; c++) binsReg.units[b * p.m + c] = work[c];
        const out = this.range(p.m).map((c) => b * p.m + c);
        this.emit(`Build L${j}: bin ${b}: write Cuckoo table`, `Write bin ${b}'s whole ${p.m}-cell Cuckoo table to the server (every cell, empty or not, so the count reveals nothing).${tab.stash.length ? ` ${tab.stash.length} item(s) that could not be placed stay in the client's stash buffer.` : ''}`,
          { stage: 'rebuild', group: `${G}: bin ${b}`, trace: out.map((u) => ({ op: 'W', r: binsReg.id, u, lab: 'build' })), hl: out.map((u) => ({ r: binsReg.id, u, k: 'write' })),
            cl: { held: stashSoFar.map((x) => ({ label: 'stash', item: x })) } });
      });
      // overflow pile Cuckoo
      const ovs = this.R('OVS');
      this.emit(`Build L${j}: overflow pile: read into client`, `Read the ${p.O}-slot staged overflow pile into private memory (${excess.length} real items).`,
        { stage: 'rebuild', group: `${G}: overflow table`, trace: this.range(p.O).map((u) => ({ op: 'R', r: 'OVS', u, lab: 'build' })), hl: this.range(p.O).map((u) => ({ r: 'OVS', u, k: 'read' })),
          cl: { held: excess.map((x) => ({ label: 'to insert', item: x })) } });
      const owork = cuckooFrames(plan.ovfTab, 'overflow', `${G}: overflow table`);
      ovReg.units = owork.slice();
      this.dropRegion('OVS');
      this.emit(`Build L${j}: overflow pile: write Cuckoo table`, `Write the overflow pile's ${p.mo}-cell Cuckoo table (all cells).`,
        { stage: 'rebuild', group: `${G}: overflow table`, trace: this.range(p.mo).map((u) => ({ op: 'W', r: ovReg.id, u, lab: 'build' })), hl: this.range(p.mo).map((u) => ({ r: ovReg.id, u, k: 'write' })),
          cl: { held: stashSoFar.map((x) => ({ label: 'stash', item: x })) } });
      // stash merge
      for (let i = 0; i < p.S; i++) stReg.units[i] = plan.stash[i] || null;
      this.dropRegion('BIN');
      this.emit(`Build L${j}: stash merge`, `Instead of one small stash per bin (which every lookup would have to scan), all ${plan.stash.length} leftover item(s) go into one combined stash of ${p.S} slots, written in full.`,
        { stage: 'rebuild', group: `${G}: stash`, trace: this.range(p.S).map((u) => ({ op: 'W', r: stReg.id, u, lab: 'build' })), hl: this.range(p.S).map((u) => ({ r: stReg.id, u, k: 'write' })) });
      lv.binSeeds = plan.seeds;
      lv.ovfSeed = plan.ovfSeed;
      lv.built = true;
    }

    // Classic Cuckoo insertion with eviction. Returns table, stash and human-readable steps.
    cuckooBuild(items, seed, m) {
      const T = new Array(m).fill(null), stash = [], steps = [];
      const MAXK = 12;
      for (const it of items) {
        let cur = it, pos = this.cuckooPos(seed, it.a, m)[0];
        const writes = [], parts = [];
        let placed = false;
        for (let k = 0; k < MAXK; k++) {
          const [h1, h2] = this.cuckooPos(seed, cur.a, m);
          if (k === 0) {
            if (!T[h1]) pos = h1; else if (!T[h2]) pos = h2; else pos = h1;
          }
          const prev = T[pos];
          T[pos] = cur;
          writes.push([pos, cur]);
          if (!prev) { parts.push(`addr ${cur.a} -> cell ${pos}`); placed = true; break; }
          parts.push(`addr ${cur.a} -> cell ${pos} (evicts ${prev.a})`);
          const [g1, g2] = this.cuckooPos(seed, prev.a, m);
          pos = pos === g1 ? g2 : g1;
          cur = prev;
        }
        if (!placed) { stash.push(cur); parts.push(`addr ${cur.a} gives up -> stash`); }
        steps.push({ writes, msg: `Insert addr ${it.a} (choices ${this.cuckooPos(seed, it.a, m).join(' or ')}): ${parts.join('; ')}. This runs inside client memory; the server sees nothing yet.` });
      }
      return { T, stash, steps, size: m };
    }
  }

  // ======================================================================
  //                              MegaBlocks
  // ======================================================================
  class MegaBlocks extends Base {
    constructor(opts) {
      opts = opts || {};
      super(opts.seed == null ? 11 : opts.seed);
      this.mode = 'megablocks';
      this.N = opts.N || 32;
      this.B = opts.B || 4;
      this.g = opts.g || 4;
      if (this.B % 2) throw new Error('B must be even');
      this.caps = [this.B];
      for (let c = this.B * (this.g - 1); c < this.N; c *= this.g) this.caps.push(c);
      this.caps.push(this.N);
      this.L = this.caps.length - 1;
      this.C = [1];
      this.lv = [{ built: true, key: 0, cnt: 0 }];
      this.addRegion({ id: 'L0', level: 0, kind: 'level', title: 'Level 0 · one block', layout: 'blocks', B: this.B, units: [[]] });
      for (let l = 1; l <= this.L; l++) {
        const K = Math.ceil(this.caps[l] / this.B);
        const C = nextPow2(2 * K);
        this.C.push(C);
        this.lv.push({ built: false, key: 0, cnt: 0 });
        this.addRegion({ id: `L${l}`, level: l, kind: 'level', title: `${C} bins = ${C} blocks of ${this.B} words`, layout: 'blocks', B: this.B, units: new Array(C).fill(null).map(() => []) });
      }
      const saved = this.frames;
      this.frames = null;
      const items = this.range(this.N).map((a) => ({ a, v: 0 }));
      const blocks = [];
      for (let i = 0; i < items.length; i += this.B) blocks.push(items.slice(i, i + this.B));
      this.addRegion({ id: 'INIT', kind: 'scratch', layout: 'blocks', B: this.B, units: blocks });
      this.rebuildInto(this.L, ['INIT']);
      this.dropRegion('INIT');
      this.frames = saved;
      this.retryLog = [];
    }

    levelInfo() {
      const out = [{ level: 0, title: 'Level 0', sub: `1 block · holds ${this.B} words`, built: true }];
      for (let l = 1; l <= this.L; l++) {
        out.push({ level: l, title: `Level ${l}`, sub: `capacity ${this.caps[l]} words · ${this.C[l]} blocks${l === this.L ? ' · largest' : ` · merges ${this.lv[l].cnt}/${this.g - 1}`}`, built: this.lv[l].built });
      }
      return out;
    }

    clientView(extra) {
      const keys = [];
      for (let l = 1; l <= this.L; l++) keys.push([`L${l}`, this.lv[l].built ? hex(this.lv[l].key) : '(empty)']);
      return {
        rows: [
          ['accesses done (t)', String(this.t)],
          ['next rebuild after access', String((Math.floor(this.t / this.B) + 1) * this.B)],
          ['merge counters', this.lv.slice(1, this.L).map((x, i) => `L${i + 1}:${x.cnt}/${this.g - 1}`).join(' ') || '(single level)'],
          ['B (words per block), growth g', `${this.B}, ${this.g}`],
        ],
        keys,
        held: extra.held || [],
        work: extra.work || null,
        note: extra.note || '',
      };
    }

    access(op, a, val) {
      a = a | 0;
      if (a < 0 || a >= this.N) throw new Error('address out of range');
      this.frames = [];
      this.curAccess = this.t;
      this.emit('Access requested', `You asked to ${op === 'write' ? `write ${val} to` : 'read'} address ${a}. Each level costs one block read + one block write.`,
        { cl: { held: [{ label: 'request', text: op === 'write' ? `write(${a}, ${val})` : `read(${a})` }] } });
      const L0 = this.R('L0');
      let blk = L0.units[0];
      let found = blk.find((x) => x.a === a) || null, foundAt = found ? 0 : -1;
      this.emit('Lookup level 0', found
        ? `Read level 0's single block into the client: address ${a} is already here (value ${found.v}). Every deeper level still gets a dummy lookup.`
        : `Read level 0's single block (up to ${this.B} recent words) into the client. Address ${a} is not here.`,
        { trace: [{ op: 'R', r: 'L0', u: 0, lab: found ? 'hit' : 'real' }], hl: [{ r: 'L0', u: 0, k: 'read', lab: found ? 'hit' : 'real' }], group: 'Lookup',
          cl: { work: { title: 'level 0 block (in client)', block: blk, B: this.B }, held: found ? [{ label: 'found', item: found }] : [] } });
      for (let l = 1; l <= this.L; l++) {
        if (!this.lv[l].built) continue;
        const reg = this.R(`L${l}`), C = this.C[l];
        let b, lab;
        if (!found) { b = prf(this.lv[l].key, a) % C; lab = 'real'; } else { b = this.rnd(C); lab = 'dummy'; }
        const bk = reg.units[b];
        let got = null;
        if (lab === 'real') got = bk.find((x) => x.a === a) || null;
        if (got) { reg.units[b] = bk.filter((x) => x !== got); found = got; foundAt = l; lab = 'hit'; }
        this.emit(`${lab === 'dummy' ? 'Dummy lookup' : 'Lookup'} level ${l}: block ${b}`,
          lab === 'dummy'
            ? `Already found, so the client reads a uniformly random block (${b}) of level ${l} and writes it back re-encrypted. Same 1 read + 1 write as a real lookup.`
            : `Bin = PRF_key${l}(${a}) mod ${C} = ${b}. Read that one block (${bk.length} of ${this.B} words used), search it inside the client, write it back.${got ? ` Found (value ${got.v}); it is removed from the block.` : ' Not in this level.'}`,
          { trace: [{ op: 'R', r: reg.id, u: b, lab }, { op: 'W', r: reg.id, u: b, lab }], hl: [{ r: reg.id, u: b, k: 'rw', lab }], group: `Lookup level ${l}`,
            cl: { work: { title: `level ${l} block ${b} (in client)`, block: bk, B: this.B }, held: found ? [{ label: 'found', item: found }] : [] } });
      }
      if (!found) throw new Error('item lost: ' + a);
      const oldV = found.v;
      const nv = op === 'write' ? (val | 0) : oldV;
      const item = { a, v: nv };
      blk = L0.units[0].filter((x) => x.a !== a).concat([item]);
      if (blk.length > this.B) throw new Error('L0 overflow');
      L0.units[0] = blk;
      this.emit('Write-back to level 0', `Write level 0's block back with (addr ${a}, value ${nv}) inside. Found in level ${foundAt}; moving it up keeps every level's lookups non-recurrent.`,
        { trace: [{ op: 'W', r: 'L0', u: 0, lab: 'real' }], hl: [{ r: 'L0', u: 0, k: 'write', lab: 'real' }], group: 'Write-back',
          cl: { held: [{ label: op === 'read' ? 'returned value' : 'old value', text: String(oldV) }, { label: 'writing', item }], work: { title: 'level 0 block (in client)', block: blk, B: this.B } } });
      this.t++;
      if (this.t % this.B === 0) this.rebuild();
      const frames = this.frames;
      this.frames = null;
      return { value: oldV, foundAt, frames };
    }

    rebuild() {
      let j = -1;
      for (let l = 1; l < this.L; l++) if (this.lv[l].cnt < this.g - 1) { j = l; break; }
      if (j < 0) j = this.L;
      const srcs = ['L0'];
      for (let l = 1; l <= j; l++) if (this.lv[l].built) srcs.push(`L${l}`);
      this.emit(`Rebuild level ${j}`,
        `Level 0's block is full (every ${this.B} accesses). With growth factor ${this.g}, a level absorbs ${this.g - 1} merges before spilling, so this time ${srcs.join(' + ')} are merged into a fresh level ${j}.`,
        { stage: 'rebuild', group: `Rebuild level ${j}` });
      this.rebuildInto(j, srcs);
      for (let l = 1; l < j; l++) { this.lv[l].built = false; this.lv[l].cnt = 0; const r = this.R(`L${l}`); r.units = r.units.map(() => []); }
      if (j < this.L) this.lv[j].cnt++;
      this.R('L0').units = [[]];
      this.emit(`Level ${j} rebuilt`, `Level ${j} is a fresh non-recurrent hash table under a new PRF key; smaller levels are empty again. Lookups resume.`,
        { stage: 'rebuild', group: 'Done' });
    }

    // Butterfly routing simulation (private). Returns per-round block contents or null on overflow.
    route(blocks, destOf) {
      const C = blocks.length, B = this.B, rounds = [];
      let cur = blocks.map((b) => b.slice());
      for (let r = 0; (1 << r) < C; r++) {
        const nxt = cur.map(() => null), bit = 1 << r;
        for (let i = 0; i < C; i++) {
          if (i & bit) continue;
          const all = cur[i].concat(cur[i | bit]);
          const lo = all.filter((x) => !(destOf(x) & bit)), hi = all.filter((x) => destOf(x) & bit);
          if (lo.length > B || hi.length > B) return null;
          nxt[i] = lo; nxt[i | bit] = hi;
        }
        cur = nxt;
        rounds.push(cur);
      }
      return rounds;
    }

    rebuildInto(j, srcs) {
      const B = this.B, C = this.C[j], K = Math.ceil(this.caps[j] / B);
      const G = `Rebuild level ${j}`;
      // ---------- 1. gather + pack ----------
      const inputs = [];
      for (const id of srcs) this.R(id).units.forEach((_, u) => inputs.push([id, u]));
      const M = inputs.length + 1;
      const pack = this.addRegion({ id: 'PACK', kind: 'scratch', title: 'packed blocks', layout: 'blocks', B, units: new Array(M).fill(null).map(() => []) });
      let buf = [], w = 0;
      for (const id of srcs) {
        const reg = this.R(id);
        const tr = [], hl = [];
        reg.units.forEach((blk, u) => {
          buf = buf.concat(blk.filter(isReal));
          let out = [];
          if (buf.length >= B) { out = buf.slice(0, B); buf = buf.slice(B); }
          pack.units[w] = out;
          tr.push({ op: 'R', r: id, u, lab: 'build' }, { op: 'W', r: 'PACK', u: w, lab: 'build' });
          hl.push({ r: id, u, k: 'read' }, { r: 'PACK', u: w, k: 'write' });
          w++;
        });
        this.emit(`${G}: gather + pack ${id}`,
          `Stream ${id}'s ${reg.units.length} block(s) through the client: drop empty slots and items already moved up, keep real words in a small buffer, and for every block read write exactly one block out (a full block when the buffer has ${B} words, otherwise an empty one).`,
          { stage: 'rebuild', group: `${G}: pack`, trace: tr, hl, cl: { work: { title: `client buffer (${buf.length} words)`, block: buf, B: 2 * B } } });
      }
      pack.units[w] = buf.slice();
      this.emit(`${G}: flush buffer`, `Write the buffer's remaining ${buf.length} word(s) as one final block.`,
        { stage: 'rebuild', group: `${G}: pack`, trace: [{ op: 'W', r: 'PACK', u: w, lab: 'build' }], hl: [{ r: 'PACK', u: w, k: 'write' }] });
      buf = [];
      // ---------- 2. oblivious compaction of blocks ----------
      this.compactRegion('PACK', (b) => b.length > 0, `${G}: oblivious compaction`, `${G}: compaction`, 'non-empty blocks');
      pack.units = pack.units.slice(0, K);
      const nReal = pack.units.reduce((s, b) => s + b.length, 0);
      this.emit(`${G}: truncate`, `Non-empty blocks are now at the front; keep the first ${K} = ceil(${this.caps[j]}/${B}) blocks. That holds all ${nReal} live words of the merged levels.`,
        { stage: 'rebuild', group: `${G}: compaction` });
      // ---------- 3. choose PRF key privately ----------
      const half = [];
      pack.units.forEach((b) => { const h = Math.ceil(b.length / 2); half.push(b.slice(0, h), b.slice(h)); });
      while (half.length < C) half.push([]);
      let key, rounds, tagged, tries = 0;
      for (;;) {
        tries++;
        key = this.newKey();
        const k = key;
        tagged = half.map((b) => b.map((x) => Object.freeze({ a: x.a, v: x.v, d: prf(k, x.a) % C })));
        rounds = this.route(tagged, (x) => x.d);
        if (rounds || C === 1) break;
        if (tries > 20000) throw new Error('butterfly: no key without overflow');
      }
      if (this.retryLog) this.retryLog.push(tries);
      const destOf = (x) => prf(key, x.a) % C;
      // ---------- 4. pad to half-full ----------
      const bf = this.addRegion({ id: 'BF', kind: 'scratch', title: 'butterfly network', layout: 'blocks', B, units: tagged.map((b) => b.slice()) });
      const tr = [], hl = [];
      for (let k = 0; k < K; k++) { tr.push({ op: 'R', r: 'PACK', u: k, lab: 'build' }); hl.push({ r: 'PACK', u: k, k: 'read' }); }
      for (let u = 0; u < C; u++) { tr.push({ op: 'W', r: 'BF', u, lab: 'build' }); hl.push({ r: 'BF', u, k: 'write' }); }
      this.emit(`${G}: pad bins to half-full`,
        `Fresh PRF key ${hex(key)}: each word is tagged with its destination bin PRF(addr) mod ${C} (shown as ->d). Each packed block is split into two half-full blocks, padded to ${C} blocks: half-full bins are what keep overflow unlikely.`,
        { stage: 'rebuild', group: `${G}: pad`, trace: tr, hl });
      this.dropRegion('PACK');
      // ---------- 5. butterfly rounds ----------
      const nR = rounds ? rounds.length : 0;
      for (let r = 0; r < nR; r++) {
        const bit = 1 << r;
        const pairs = [];
        for (let i = 0; i < C; i++) if (!(i & bit)) pairs.push([i, i | bit]);
        const perPair = C <= 8;
        const groups = perPair ? pairs.map((p) => [p]) : [pairs];
        for (const grp of groups) {
          const t2 = [], h2 = [];
          let moved = 0;
          for (const [x, y] of grp) {
            const before = bf.units[x];
            bf.units[x] = rounds[r][x]; bf.units[y] = rounds[r][y];
            moved += before.filter((it) => it.d & bit).length;
            t2.push({ op: 'R', r: 'BF', u: x, lab: 'build' }, { op: 'R', r: 'BF', u: y, lab: 'build' }, { op: 'W', r: 'BF', u: x, lab: 'build' }, { op: 'W', r: 'BF', u: y, lab: 'build' });
            h2.push({ r: 'BF', u: x, k: 'rw', swap: true }, { r: 'BF', u: y, k: 'rw', swap: true });
          }
          const first = grp[0];
          this.emit(`${G}: butterfly round ${r + 1}/${nR}: split by bit ${r}`,
            perPair
              ? `Read blocks ${first[0]} and ${first[1]} into the client (2 blocks of private memory), send words whose destination has bit ${r} = 0 to block ${first[0]} and bit ${r} = 1 to block ${first[1]}, write both back.`
              : `Round ${r + 1}: for each of the ${grp.length} block pairs (i, i + ${bit}), the client reads both, splits the words by bit ${r} of their destination, and writes both back. Fixed pairs, so the pattern is data independent.`,
            { stage: 'rebuild', group: `${G}: butterfly`, trace: t2, hl: h2, cl: { work: { title: `blocks ${first[0]} + ${first[1]} in client`, block: bf.units[first[0]].concat(bf.units[first[1]]), B: 2 * B } } });
        }
      }
      bf.units.forEach((b, u) => b.forEach((x) => { if (x.d !== u) throw new Error('butterfly misrouted'); }));
      // ---------- install ----------
      const reg = this.R(`L${j}`);
      reg.units = bf.units.slice();
      this.dropRegion('BF');
      this.lv[j].key = key;
      this.lv[j].built = true;
      for (const id of srcs) if (id !== `L${j}` && id !== 'INIT') { const r = this.R(id); r.units = r.units.map(() => []); }
      this.emit(`${G}: install`, `After ${nR} rounds every word sits in block number PRF(addr) mod ${C}: exactly the bin a later lookup will read. The butterfly result becomes level ${j}.`,
        { stage: 'rebuild', group: `${G}: install`, hl: this.range(C).map((u) => ({ r: reg.id, u, k: 'write' })) });
    }
  }

  function create(mode, opts) {
    return mode === 'megablocks' ? new MegaBlocks(opts) : new OptORAMa(opts);
  }

  return { create, OptORAMa, MegaBlocks, prf, hex, batcherStages, expanderStages, isReal };
});
