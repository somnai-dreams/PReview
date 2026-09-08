# Fiber and mutation-tracking experiment

This is an opt-in experiment, not a faster replacement for PReview's restore engine. Normal validation, comparison and restoration remain authoritative. It adds no dependency on Bippy; the small observer uses React's DevTools hook directly and chains an existing commit callback.

Run `bun experiments/fiber/serve.ts` and open http://localhost:4790. The two example builds run on 4791 and 4792. The observer script must load before React. The launcher sets `PREVIEW_FIBER_PROBE=1` for compiler-to-fiber registration and shadow capture audits. Setting that variable with an ordinary launcher that does not load the observer script is unsupported.

The experiment retains compiler-generated cell names and schemas. At each commit it walks fibers, finds PReview's registered hook tokens, and maps each to its owning fiber. State overrides use the renderer's `overrideHookState` API. The index offsets describe PReview's own wrappers; changes to those wrappers require updating the adapter. The override is restricted to the tested React 18.3.1 development renderer. This is private React API, not a supported cross-version protocol.

Build B has an extra hook before the observed state. Its override control must still change the draft without changing the earlier state. This tests the hybrid's stable-name mapping rather than assuming the same hook index in both builds.

The Fiber probe panel contains only counts, timing, renderer versions and identities of unpredicted outgoing cells. Its audit compares React-commit/root-identity predictions with the existing full comparison. Cells absent from the previous checkpoint must be sent regardless of whether a write occurred; they are not counted as missed mutations. The audit does not disable data checks.

## Mutation coverage gates

The proxy prototype observes property writes, nested array edits, Map/Set mutations, property definitions and deletions made through wrapped references. Shared wrapped objects preserve identity with one another. It deliberately remains outside the real application runtime.

Two reproducible counterexamples prevent using its revision counter to skip scans automatically:

- An object or Map retained before wrapping can be mutated through the original alias without reaching any proxy trap.
- A raw object assigned into a wrapped container can later be mutated through its original reference. Tracking the insertion does not make subsequent writes observable.

Wrapping also changes identity relative to the original object. It does not provide a transparent interception boundary for arbitrary existing application code. Copying at ingress would require exclusive ownership and would change sharing semantics.

The mutation tests assert these known misses so they cannot be mistaken for passing coverage. The browser controls reproduce the first case, and an ordinary ref mutation without a render demonstrates the separate limitation of fiber observation. The normal transfer still catches that mutation and carries it to the other build.

## Measurement boundaries

The setter and fiber-override controls measure a synchronous React update in the synthetic app. The large-graph control measures three full read phases over 20,000 rows with 40,960,000 payload characters, then a revision read and a wrapped-write detection check. These are component measurements, not end-to-end timings for a replacement transfer engine, and the payload count is not network bytes.

The experiment establishes whether React observation/overrides work and whether mutation coverage is sufficient to replace scans. A faster end-to-end engine is not established by a fast revision check that misses legal writes. The current proxy-based shortcut fails that coverage gate. A future compiler write-observation experiment could retain raw object identity, but would need explicit coverage for aliases, native collection operations and writes from uninstrumented dependencies before being trusted.

## Local synthetic results, 2026-09-08

The browser control updated the intended state through the React 18.3.1 renderer. Observed overrides took 0.7–1.2 ms; a normal setter took 2 ms in the first run and 5.5 ms on a fresh final load. These were exploratory, unbalanced observations with different warm-up, not a speedup estimate. With an extra hook inserted in B, overriding the draft still preserved the earlier state value.

The final large-graph probe took 321.5 ms for three read phases. The revision read was below the timer's displayed resolution, and a wrapped write incremented it. However, the raw-alias browser control changed the data without changing the revision. Both raw-alias cases also reproduced in unit tests.

After warming both frames, mutating a ref without rendering produced one changed cell that fiber prediction missed. The normal transfer caught it and the destination displayed the new ref value and appended entry. A fast path that trusted only this prediction would have lost that edit. No replacement end-to-end transfer speedup is claimed.
