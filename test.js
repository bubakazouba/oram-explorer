// Headless logic test of the simulation core.
const S = require('./sim-core.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };

// (op, region) sequence. Reads of OptORAMa's PRF staging bins ('BIN') are excluded because
// how they split across bins is exactly the publicly revealed balls-into-bins load vector
// (by design; the secret loads mask it). Their total count is still covered by the length check.
function shape(frames) { return frames.flatMap(f => f.trace.filter(e => !(e.r === 'BIN' && e.op === 'R')).map(e => e.op + ':' + e.r)).join(','); }
function len(frames) { return frames.reduce((s, f) => s + f.trace.length, 0); }

function runMode(mode, opts, steps, seedA, seedB) {
  // correctness: random reads/writes vs a reference map
  const sim = S.create(mode, Object.assign({ seed: seedA }, opts));
  sim.snapshots = false;
  const ref = new Array(sim.N).fill(0);
  const rnd = (() => { let x = seedA * 9973 + 1; return n => { x = (x * 1103515245 + 12345) % 2147483648; return (x >>> 12) % n; }; })();
  let reads = 0, bad = 0;
  const lens = [], shapes = [];
  for (let i = 0; i < steps; i++) {
    const a = rnd(sim.N), op = rnd(2) ? 'write' : 'read', v = rnd(1000);
    const r = sim.access(op, a, v);
    if (r.value !== ref[a]) bad++;
    if (op === 'read') reads++;
    if (op === 'write') ref[a] = v;
    lens.push(len(r.frames)); shapes.push(shape(r.frames));
  }
  ok(bad === 0, `${mode} ${JSON.stringify(opts)}: ${bad} wrong values`);
  // final full read-back
  let bad2 = 0;
  for (let a = 0; a < sim.N; a++) if (sim.access('read', a).value !== ref[a]) bad2++;
  ok(bad2 === 0, `${mode}: final read-back ${bad2} wrong`);

  // obliviousness of counts and of the coarse pattern: a totally different address
  // sequence (hot single address) with different randomness must give identical
  // per-access trace length AND identical (op, region) sequence.
  const simB = S.create(mode, Object.assign({ seed: seedB }, opts));
  simB.snapshots = false;
  let lenMismatch = 0, shapeMismatch = 0;
  for (let i = 0; i < steps; i++) {
    const r = simB.access(i % 3 ? 'read' : 'write', 0, i);
    if (len(r.frames) !== lens[i]) lenMismatch++;
    if (shape(r.frames) !== shapes[i]) shapeMismatch++;
  }
  ok(lenMismatch === 0, `${mode}: ${lenMismatch} accesses with different trace length`);
  ok(shapeMismatch === 0, `${mode}: ${shapeMismatch} accesses with different (op,region) pattern`);
  const lookupLens = [...new Set(lens)].sort((a, b) => a - b);
  console.log(`${mode.padEnd(10)} ${JSON.stringify(opts).padEnd(26)} accesses=${steps + sim.N} reads=${reads + sim.N} wrong=${bad + bad2} ` +
    `traceLen mismatches=${lenMismatch} pattern mismatches=${shapeMismatch} distinct per-access I/O counts=${lookupLens.slice(0, 6).join('/')}${lookupLens.length > 6 ? '/...' : ''}` +
    (sim.retryLog ? ` keyRetries(avg)=${(sim.retryLog.reduce((s, x) => s + x, 0) / sim.retryLog.length).toFixed(1)}` : ''));
}

// network sanity
for (let n = 1; n <= 70; n++) {
  for (let trial = 0; trial < 20; trial++) {
    const arr = Array.from({ length: n }, () => Math.random() < 0.4);
    const k = arr.filter(Boolean).length;
    for (const st of S.expanderStages(n).concat(S.batcherStages(n)))
      for (const [i, j] of st) if (!arr[i] && arr[j]) { arr[i] = true; arr[j] = false; }
    ok(arr.every((x, i) => x === (i < k)), 'compaction network n=' + n);
  }
}

runMode('optorama', { N: 8 }, 200, 3, 99);
runMode('optorama', { N: 16 }, 200, 5, 77);
runMode('optorama', { N: 32 }, 200, 8, 66);
runMode('megablocks', { N: 16, B: 4, g: 3 }, 200, 4, 55);
runMode('megablocks', { N: 32, B: 4, g: 4 }, 200, 6, 44);
runMode('megablocks', { N: 64, B: 4, g: 4 }, 200, 9, 33);
runMode('megablocks', { N: 64, B: 8, g: 3 }, 200, 10, 22);

// snapshot-mode smoke test (what the browser uses)
for (const mode of ['optorama', 'megablocks']) {
  const sim = S.create(mode, { N: 32 });
  let frames = 0;
  for (let i = 0; i < 20; i++) frames += sim.access('write', i, i * 10).frames.length;
  ok(sim.access('read', 7).value === 70, mode + ' snapshot-mode read');
  console.log(`${mode} snapshot mode: 20 accesses -> ${frames} frames`);
}
console.log(fails ? `${fails} FAILURES` : 'ALL TESTS PASSED');
process.exit(fails ? 1 : 0);
