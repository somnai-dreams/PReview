# Incremental comparison experiment

Run `bun experiments/incremental/serve.ts` and open `http://localhost:4770`.
For an uninstrumented control, run `PREVIEW_INCREMENTAL=0 PORT=4760 bun experiments/incremental/serve.ts`.
The example has 20,000 rows with 2,048 characters each, a draft, and a selection that aliases a feed row. It includes writes through an old raw alias and writes without rendering.

This is opt-in. The normal reviewer continues using full comparison. The host's Comparison engine control can disable the incremental comparator while retaining the same instrumentation, making that a different control from the uninstrumented launch above.

## What is retained

After a full validation/comparison, a frame indexes the correspondence between its owned checkpoint and live objects. Compiler write markers report the receiver and, where statically known, the field. Native collection mutations mark a whole container. Before the next comparison, the journal checks touched fields against the checkpoint. A same-value assignment leaves the existing correspondence valid.

A clean root activates its verified mapping without walking the graph. A phase-local overlay prevents cached and newly compared aliases from conflicting. Restoration reads that mapping directly instead of copying every pair into a fresh map and set. Mappings live with their checkpoint; removed roots release their object subscriptions.

A real change invalidates the affected root's proof. That root uses full comparison and, when needed, normal copying and index rebuilding. This is not field-level delta transport for large changed graphs. Index reuse currently pays off for unchanged roots and no-op writes.

## Observation boundary

The build plugin instruments bundled app and dependency property writes. Known unsupported syntax disables acceleration. Detected runtime code generation disables it too, before the marked expression runs. This fallback is deliberately broad: constructing a function or invoking a method named `constructor` can disable it even if that particular operation is harmless.

This is not a universal guarantee for arbitrary JavaScript. An aliased dynamic evaluator, foreign script or foreign-realm native method can evade these detectors. Callers must not enable the experiment where mutations can arrive outside the instrumented bundle and observed native methods. The ordinary full comparison remains the authority for those apps. A successful synthetic example is not evidence of complete application coverage.

No React fiber writes, proxy-wrapped application objects, per-feature adapters, credentials, or network transport are added. The preload installs native mutation observers and the bridge retains its existing parent/origin checks. This is a local development experiment, not a production script.

## Verification

Tests exercise no-op writes, actual edits, equal object replacement followed by raw-alias writes, array truncation, accessor rejection, ordered collections, shared aliases, rollback of failed candidates, effect-driven repair, lazy restoration, and fallback before dynamic evaluation. The example exposes complete switch timing through destination reveal and a paint boundary. Initial checkpoint creation must be kept separate from warm switches.

Performance observations from the public reproduction are recorded below after measurement. Index counts are not a browser heap measurement; the index adds per-object storage and has an initial construction cost.

## Public browser reproduction (8 September 2026)

The same synthetic app ran in the in-app browser, once with the incremental preload and once with `PREVIEW_INCREMENTAL=0`. The first two transfers in each run were treated as warmup. Four subsequent complete switches measured:

| Mode | Warm switches (ms) | Median | Maximum | Initial transfer |
| --- | --- | --- | --- | --- |
| Incremental | 23.3, 23.1, 22.6, 22.9 | 23.0 ms | 23.3 ms | 297.1 ms |
| Uninstrumented full comparison | 55.7, 47.7, 47.3, 48.2 | 47.95 ms | 55.7 ms | 279.9 ms |

That is a 2.08x median improvement on this small synthetic sample, with no rejected or changed cells. It is not an arbitrary-application performance result. The index held 20,002 objects per frame and was built once per frame (12.8–14.9 ms); browser heap usage was not measured. The repeated content is synthetic: its character count does not establish its physical heap or wire size.

Four 20,000-assignment loops took 4.10, 1.40, 1.50 and 1.30 ms with observation, versus 0.30, 0.40, 0.10 and 0.20 ms without it. These measure the loop, not the subsequent React render. A later transfer containing an actual nested feed edit took 365 ms. The destination showed the edited old-alias value, the toggled flag, the typed draft, and `Shared identity: true` in the selection. These results support retained-root reuse, not fast transfer of every mutation.

Each frame still keeps only its current checkpoint. Switching to a build without the matching base requests a full packet, so these two-build warm results do not imply cheap arbitrary three-way cycling.
