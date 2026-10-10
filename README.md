# ORAM Explorer

Interactive, step-by-step simulator of **OptORAMa** (Eurocrypt 2020) and **MegaBlocks** (CCS 2025) hierarchical Oblivious RAMs at toy sizes.

Live: https://bubakazouba.github.io/oram-explorer/

Issue reads and writes, then watch what the client holds, what the server stores, which cells are read, written or swapped, which phase is running, and the exact physical trace the server observes (toggle "Reveal real vs dummy" off to see only the server's view).

- `sim-core.js`: real toy implementations (hierarchical levels, Cuckoo tables with eviction, overflow pile, secret loads, combined stash, tight compaction network, intersperse; MegaBlocks dynamic packing, block compaction, half-full padding, butterfly bin packing). Every logical access is compiled into animation frames.
- `app.js`, `index.html`, `style.css`: the UI. Plain static files, no build, no dependencies.
- `test.js`: `node test.js` checks every read against a plain array (200 random ops per config) and that per-access trace lengths and (op, region) patterns are identical for very different address sequences.

See the "About / simplifications" tab for exactly what is simplified.
