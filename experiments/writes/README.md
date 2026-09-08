# Compiler write-observation experiment

Run `PREVIEW_WRITE_PROBE=1 bun experiments/fiber/serve.ts` and open http://localhost:4790. This adds the Write probe panel and compiler-write controls to the existing two-build experiment. It remains opt-in; ordinary PReview capture, validation, comparison and restore are authoritative.

The build plugin marks the receiver of property assignments, increments, decrements, deletions, destructuring assignments and loop targets. It leaves the original write expression in place and returns the exact original object. Old aliases and newly inserted objects retain their identity. The plugin instruments bundled application modules, dependencies and PReview's restoration code. It excludes the observer and its bookkeeping to prevent recursion.

A preload observes native Map, Set, Array, Object and Reflect mutators, including methods extracted after installation and invoked with `call` or `apply`. These wrappers preserve receiver, arguments, result and thrown errors. They change native function identity in this development realm. They conservatively record attempted writes, including assignments of the same value and operations that eventually throw.

A watch subscribes to every object reachable from one accepted cell, including object Map keys. A write marks the watches subscribed to that original object. Root replacement is checked separately. Membership indexes are reused while clean; observed writes require rebuilding them. Unmounted or rejected owners release their subscriptions. Restore writes use the same markers, so a verified restore can keep a clean index. Values that fail post-commit verification remain unindexed.

## What the audit establishes

The probe compares its cheap prediction against full comparison at capture. A cell absent from the checkpoint is necessarily transmitted, even if it has not changed locally. Previously accepted cells remain in the audit if an edit makes them invalid; unvalidated values are never indexed. This prevents reporting success by excluding exactly the dangerous edits.

The panel exposes counts, operation totals, timings and the identities of the largest observed cells and missed predictions. It does not display or send application values. Diagnostics and graph indexing add real overhead. `predictionMs` alone is not transfer latency; `indexingMs` and `lastRestoreIndexMs` must be counted too.

The generic controls cover old raw aliases, writes through a raw object inserted earlier, extracted Map methods, and an unrendered ref mutation. Tests also cover destructuring, evaluation order, shared-owner cleanup, object Map keys, restore mutations through nested aliases, invalid data, and index lifetime.

## Coverage limits

This is a build-boundary experiment, not a universal JavaScript observer. Property writes in scripts outside the plugin, dynamically generated code, foreign realms, or modules loaded before the preload can bypass it. Foreign or previously saved native methods can bypass this realm's wrappers. The compiler reports unsupported `super` receivers and modules that shadow `globalThis`; a zero unsupported count only covers syntax seen by this compiler, not all possible execution.

The tests deliberately preserve a counterexample where an uninstrumented property write is missed. For that reason, the experiment does not skip scans or enable a fast path. Restoring data still relies on the existing type checks and shared-reference rules. There is no added network endpoint or remote execution surface.

## Decision

Compiler markers address alias holes that defeated proxy observation and work without a React render. But a write is not necessarily a value change. Reindexing a large graph after same-value writes can cost more than the comparison it is intended to replace. A production optimization needs a verified way to retain the correspondence between live data and its checkpoint, invalidate it on actual changes, and fall back when write coverage is incomplete. This experiment supplies coverage and cost evidence for that decision; it does not establish an end-to-end speedup.

## Synthetic browser results, 2026-09-08

The final public-checkout run preserved raw object identity and detected old-alias, inserted-alias and extracted-Map writes. After warming both frames, an unrendered ref edit produced one changed cell: compiler observation detected it and fiber prediction missed it. The ordinary transfer displayed the edited value and appended array entry in the destination.

For 20,000 synthetic rows containing 40,960,000 payload characters, initial indexing took 79.1 ms, three full comparisons took 335.6 ms, and releasing the index took 29.8 ms. Reading the dirty flag was below the displayed timer resolution. These are exploratory component measurements, not a balanced benchmark or an end-to-end improvement.

The public checks passed 46 tests / 235 assertions plus TypeScript and lint. Known coverage counterexamples remain explicit passing tests of a limitation, not evidence of universal interception.
