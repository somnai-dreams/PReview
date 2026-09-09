# Incremental comparison experiment

Run `bun examples/incremental/serve.ts` and open `http://localhost:4770`.
For an uninstrumented control, run `PREVIEW_INCREMENTAL=0 PORT=4760 bun examples/incremental/serve.ts`.
The example has 20,000 rows with 2,048 characters each, a draft, and a selection that aliases a feed row. It includes writes through an old raw alias and writes without rendering.

This is opt-in. The normal reviewer continues using full comparison. The host's Comparison engine control can disable the incremental comparator while retaining the same instrumentation, making that a different control from the uninstrumented launch above.

## What is retained

After a full validation/comparison, a frame indexes the correspondence between its owned checkpoint and live objects. Compiler write markers report the receiver and, where statically known, the field. Native collection mutations mark a whole container. Before the next comparison, the journal checks touched fields against the checkpoint. A same-value assignment leaves the existing correspondence valid.

A clean root activates its verified mapping without walking the graph. A phase-local overlay prevents cached and newly compared aliases from conflicting. Restoration reads that mapping directly instead of copying every pair into a fresh map and set. Mappings live with their checkpoint; removed roots release their object subscriptions.

A real change invalidates the affected root's proof. That root uses full comparison and, when needed, normal copying and index rebuilding. This is not field-level delta transport for large changed graphs. Index reuse currently pays off for unchanged roots and no-op writes.

## Observation boundary

The build plugin instruments bundled app and dependency property writes. The preload also intercepts the native Function, AsyncFunction, GeneratorFunction and AsyncGeneratorFunction constructors before application code. It instruments generated parameters and bodies with the same compiler pass, including closures and default parameters. Constructor aliases captured after preload are covered. Empty capability checks and ordinary `.constructor()` calls no longer disable acceleration.

Native construction performs the original argument coercion, syntax validation and CSP checks first. If rewriting is needed, a second native construction receives the rewritten strings. The returned function keeps the original function kind and custom prototype; application data is never proxied. This adds work when functions are created. The parser, source text and intermediate functions are not cached per generated function.

Known unsupported syntax or generated scopes disable acceleration. Detected eval calls disable it before evaluation, preserving direct eval's lexical scope. Parser diagnostics cannot be treated as complete observation. Constructor wrapping and rewritten Function#toString output are observable development-time changes; this is not transparent to every reflective program.

This is not a universal guarantee for arbitrary JavaScript. An aliased dynamic evaluator, foreign script or foreign-realm native method can evade these detectors. Callers must not enable the experiment where mutations can arrive outside the instrumented bundle and observed native methods. The ordinary full comparison remains the authority for those apps. A successful synthetic example is not evidence of complete application coverage.

No React fiber writes, proxy-wrapped application objects, per-feature adapters, credentials, or network transport are added. The preload installs native mutation observers and the bridge retains its existing parent/origin checks. This is a local development experiment, not a production script.

## Verification

Tests exercise no-op writes, actual edits, equal object replacement followed by raw-alias writes, array truncation, accessor rejection, ordered collections, shared aliases, rollback of failed candidates, effect-driven repair, lazy restoration, and fallback before dynamic evaluation. Generated-function tests cover closures, constructor aliases, default parameters, strict mode, coercion and custom prototype lookup exactly once, async/generator writes, and unsupported scopes. The example exposes complete switch timing through destination reveal and a paint boundary. Initial checkpoint creation must be kept separate from warm switches.

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

## Generated-function reproduction (8 September 2026)

The example now has a button that mutates an old row alias inside a runtime-generated closure. In the connected browser, this edit transferred in 323 ms and preserved the selected row's shared identity. Coverage stayed enabled: one function was created and transformed per frame, with zero fallbacks. Before that edit, four warm switches took 23.1, 22.6, 22.7 and 23.0 ms (median 22.85 ms); the initial transfer took 281.1 ms. These are synthetic results, not an application-wide claim.

Reusing the existing TypeScript parser adds a roughly 4.2 MB minified preload, served without compression by this local fixture. Fetching, parsing and evaluating that preload took 191.6 ms and 122.4 ms in the two frames. Generating the small closure took 3.3 ms and 3.2 ms, including both native construction and instrumentation. The diagnostic panel reports cumulative generated-code compilation time and total browser heap when available. Total heap includes the application, checkpoints, retained indexes and transient allocations; it does not isolate parser overhead. A controlled retained-heap measurement is still missing. The parser is retained, but individual generated source strings and ASTs are not kept in a cache.

Launchers place a `preview-preload-start` performance mark immediately before loading the preload. This makes the displayed preload duration include its fetch, parse and evaluation rather than only timing the module body after parsing.

## Changed-subgraph reproduction (9 September 2026)

A temporary version of this React example used 100,000 rows (about 300,000 objects per frame), each with nested metadata and tags, a selected-row alias, and an effect that replaces a derived ref after every commit. Both versions used real compiler/native write observation, including restoration writes. Each ran in a fresh Chrome process. After an initial transfer and return, three nested flag edits were transferred with a return between each edit.

| Observation | Before subgraph patches | With subgraph patches |
| --- | --- | --- |
| Edited switches | 2,254 / 2,347 / 2,212 ms | 466 / 469 / 440 ms |
| Returns without an edit | 111–130 ms | 34–50 ms |
| Initial transfer | 1,842 ms | 2,335 ms |
| Retained JS heap after collection | 166 MB | 218 MB |

The edited-switch median fell about 79%. Each edited capture used four container patches and copied zero complete objects. The selected row retained shared identity; no cell was rejected. The deliberately effect-reset derived ref remained reported as changed after repair in both versions. Heap measurements cover the test page's JavaScript isolate after the same sequence and forced collection; they are not peak RSS or per-frame allocation measurements.

This is a small synthetic comparison, not a hosted latency guarantee. It exposes the tradeoff: finer correspondence and validation reuse consume more retained memory and did not improve the first transfer. New data still needs copying and validation, and patching a large array still requires scanning/shallow-copying its entries. A separate 200-step data-level sequence checked nested edits, reordered collections, equal replacements and changing aliases across alternating transfers without retaining obsolete index nodes.

A subsequent index-only Chrome probe used the same 100,000 rows and 300,001 indexed objects in separate fresh browser processes. Keeping single parent/child links directly, and allocating lists only for branching, reduced collected JavaScript heap from 84,245,296 to 47,473,336 bytes. These totals include identical live and checkpoint data, not just the index. This isolates index representation; it does not replace the full runtime or hosted measurements above. The shared-parent tests and 200-step alternating mutation sequence still pass.
