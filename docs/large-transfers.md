# Large initial transfers: measured costs and next design

The baseline investigation below covers the runtime at `95c8eea`. The implementation and measurements at the end describe the subsequent correspondence consolidation; they do not establish that large real application transfers are fixed. Preserve all supported state and aliases. Do not infer that a large collection is expendable, weaken destination validation, or require changes to application feature files.

## What was measured

A temporary synthetic browser harness loaded two builds with 100,000 rows each. Every row had metadata, tags and eight nested detail records: about 1.2 million objects per build. Three observed refs shared the graph, including a selected row and a derived wrapper replaced after each simulated commit. It exercised the current capture/restore core, real MessageChannels, native mutation observation and instrumented restore writes. It did not exercise React rendering, authentication, application network traffic or a real application's data.

Each comparison below started in a fresh Chrome process with precise memory information and CPU profiling enabled. The sequence was an initial transfer, a return, one nested edit, and another return. These are single-run observations, not statistical latency estimates. Timing includes profiler overhead. The memory sample maximum is the largest value at an instrumented phase boundary, not a continuously measured peak. All memory values are decimal MB and cover the two-frame renderer.

| Variant | Initial transfer | Collected heap after initial transfer | Largest phase-boundary heap sample |
| --- | ---: | ---: | ---: |
| Current runtime | 9,210 ms | 612 MB | 1,228 MB |
| Fused validation and snapshot construction | 8,137 ms | 602 MB | 1,217 MB |
| Replace temporary index maps with construction generations | 8,443 ms | 622 MB | 1,082 MB |
| Flat correspondence columns instead of per-object link records | 8,010 ms | 607 MB | 1,122 MB |

Before the initial transfer, collected heap was about 195 MB in each fresh process. After the current-runtime sequence, releasing both correspondence indexes and collecting garbage reduced heap from 612 MB to 387 MB. Releasing checkpoints then reduced it to 299 MB. These interventions identify substantial retained index storage; they do not isolate every validation allocation, string representation change, or application allocation caused by restoration.

In the current runtime, source validation/copying/copy validation took about 2.5 seconds, source indexing 0.8 seconds, destination validation 2.3 seconds, and repair comparison/indexing another 2.0 seconds. Message serialization and delivery were a smaller part. CPU samples also showed substantial garbage collection and native-mutation wrapper overhead. Moving only the transport cannot remove these costs.

The flat prototype passed the existing 29 graph/value checks (156 assertions) and a 200-step mutation/alias sequence. A separate browser check examined every row and nested detail in both builds after the transfer sequence: no mismatches, and selection identity remained shared. The prototype deliberately omitted production slot recycling; it is not ready for long-lived sessions. The fused-copy prototype also needs complete failure-path and cross-schema validation before adoption. None of these temporary prototypes changed the released runtime.

## What the prototypes ruled out

Small representation changes reduce some allocation and indexing time, but they leave most retained memory and full-graph passes intact. The fused-copy experiment removes a repeated validation traversal, yet barely changes the memory maximum. No result establishes that either change alone fixes a large real-world workload.

A binary transport or chunking may later reduce transport allocations. Neither by itself removes the full snapshots, comparison maps, restoration maps, and indexes still retained by the current control flow. A worker would likewise need a deliberate ownership redesign to reduce total duplication.

## Recommended implementation slice

Use one graph correspondence index throughout capture and restoration, with an explicit construction phase. The current algorithms repeatedly establish the same fact: this snapshot object corresponds to this live object.

1. **Capture establishes the correspondence while validating and constructing the owned snapshot.** Keep one lookup for shared references. Successful validation should accompany the exact immutable copy it proves; do not validate the live graph, clone it, and then rediscover its validity and correspondence in independent complete walks.
2. **Restore records correspondence as it reconciles values.** Destination schema and live-ref safety checks still precede application writes. Controlled reconciliation knows what values it has written. Record that fact directly instead of reconstructing it by comparing the entire graph afterward.
3. **Observe the commit's application writes against those correspondences.** Effects, new mounts, root replacement and shared aliases can still change the result. Drain the existing write observer, repair affected data, and report unresolved changes or rejection. Use the complete comparison path whenever observation coverage is incomplete.
4. **Give construction scratch data one lifetime.** Once the permanent index owns a correspondence, release the temporary copy/comparison/claim representation. Avoid retaining those complete maps while allocating another complete index. Keep canonical destination identities for unsettled values until repair finishes.

This is a proposal to consolidate ownership and ordering, not to remove validation or assume effects are harmless. The builder must not publish a proof for a partially constructed graph. New roots must acquire ownership before old roots are released. Aliases shared across retained and changed roots must use the same correspondence, including when a later candidate fails.

The intended internal boundary is begin construction → validate/copy or reconcile and record pairs → commit roots → observe application effects → repair affected pairs → finish. Ordinary values remain the application's data model; no per-feature registration or state-size exclusions are introduced.

## Acceptance gates

Before replacing the current runtime:

- Preserve values and aliases across additions, removals, reorderings, shared-root joins/splits, remounts, and incompatible destination schemas. A failed candidate must not leave a reusable proof for data that was not accepted.
- Preserve real effect mutations and mutations through old aliases. Incomplete write coverage must retain the full-check behavior.
- Bound slot/storage growth across repeated capture, repair, clear, and replacement sequences. Old comparison phases must never mistake a recycled numeric slot for its previous object.
- Repeat the same clean-browser workload with complete data verification, recording initial and repeated-transfer time, collected heap, and phase samples. The goal is fewer simultaneously retained graph representations, not just moving the wait to another phase.
- Verify the failing application workflow itself before claiming the issue fixed. Synthetic results establish a mechanism and candidate direction, not application success.

If this consolidation still leaves unacceptable retained memory, the next architecture to prototype is a versioned object journal with temporary wire snapshots. It could remove the permanent duplicate snapshot, but first needs a proof for concurrent writes, destination drift, repair, and multi-build baselines. That larger protocol change is not justified as the first implementation step by the measurements above.

## Implemented consolidation

Capture now constructs owned snapshots when validation completes each object and records their live correspondence immediately. It attaches schema proofs to those exact copies. The wire encoder reuses owned data where no reference marker is needed; source capture no longer decodes and revalidates its own output.

Reconciliation records canonical objects directly in the same index before React effects run. Unfinished nodes remain invalid. Construction retains only unattached roots, connects children before releasing prior ownership, and releases rejected or superseded graphs when the transfer ends. Restoration uses these correspondences for copy identity and destination claims instead of retaining complete additional maps. Full comparisons remain the fallback when write coverage is incomplete.

Repair validates replacement refs through already checked, unchanged subgraphs. Generic plain-data validation chooses the actual container kind directly instead of trying a multi-branch union at every node. Prototype, descriptor, finite-number, resource, primitive Map-key and cycle checks remain enforced.

The same clean-browser 100,000-row workload measured an initial transfer of **4,507 ms**, an unchanged return of **2.1 ms**, a nested edit of **556 ms**, and another return of **1.4 ms**. Collected heap after the initial transfer was **580 MB**; the largest phase sample was **809 MB**. Against the recorded baseline, these observations reduce initial latency by about 51% and the sampled heap maximum by about 34%. Retained heap falls only about 5%, so permanent graph storage remains a limitation. These are individual profiled synthetic runs, with the same limitations described above.

Both frames passed a complete check of every row, tag, metadata value and detail record after the sequence; selection identity stayed shared. A 200-step addition/removal/reordering/alias sequence also passed and released obsolete index entries. Regression checks exercise first-commit effect writes through old aliases, incomplete coverage, rejected capture roots, collection ordering, remount repair and incompatible schemas. Hosted application success still requires the fully loaded real workflow.

## Direct identities and removing reference searches

A subsequent isolated prototype replaced permanent checkpoint copies with weak object identities and coalesced current-object updates. It established the initial correspondence, sent changed objects and destination drift by identity, preserved aliases, and retained writes made after capture for the next transfer. Fourteen mechanism tests passed, including 200 alternating mutation steps, rejection before writes, and collection of obsolete identities. A 300,000-row test transferred a late selection with zero object records and a metadata edit with one record, without traversing the library.

This prototype is not a replacement runtime. It lacks the current engine's declared-type validation, React repair, incomplete-observation fallback and multi-build/session protocol. Its performance is a mechanism result, not an equivalent implementation or a hosted latency claim.

The browser comparison used 100,000 rows with eight detail records per row, or 1,200,002 objects per frame. Each variant ran once in a fresh Chrome process with real MessageChannels, native-write observation and compiled property writes. CPU profiling was disabled. The three roots shared the feed, a selected row, and a wrapper. React, authentication and network traffic were absent; wrapper replacement was explicit and identical across variants. Both frames passed a complete value and alias check after each sequence. Timings below are individual observations in milliseconds, not distribution estimates.

| Work | Existing engine | Direct-identity prototype | Existing engine with ancestor-scoped search |
| --- | ---: | ---: | ---: |
| Initial transfer | 4,778 | 5,866 | 4,843 |
| Select last row | 279 | 0.2 | 15 |
| Edit last row metadata | 776 | 0.3 | 561 |
| Replace equal wrapper around feed | 0.4 | 1,251 | 0.6 |
| Collected heap after initial transfer, decimal MB | 580 | 448 | 580 |

Direct identities eliminated reference-path discovery for small changes. However, normalizing every initial object into wire node/field records raised synchronous message serialization from about 192 to 1,092 ms. Its conservative structural validation then walked all 1.2 million objects to accept one new wrapper. Releasing both application graphs and collecting garbage removed every prototype identity entry. The memory reduction therefore did not depend on retaining old objects indefinitely, but it also did not solve initial-transfer cost.

The usable change takes advantage of information the existing index already owns: parent links in immutable checkpoint data. Encoding computes the ancestors of the objects it needs to reference, then skips unrelated subtrees during path discovery. That temporary set lasts only for the current encoding. It adds no permanent index, changes no wire format, and retains full traversal when correspondence information is unavailable. After this measurement, scope construction was capped at 4,096 queued links so an object shared by thousands of parents cannot cause an unbounded preliminary search; exceeding that bound uses the existing traversal. The large parent array still gets scanned; this is not constant-time lookup. Cold transfer and retained heap remain essentially unchanged in this measurement.

A separate real React fixture with 100,000 rows preserved its selected last-row alias through three nested edits and returns. An effect replaced a derived wrapper after every commit; that remaining difference was reported, and no cells were rejected. Edited switches took 310–377 ms and unchanged returns 9–53 ms. This is a functional smoke check with a different workload, not another before/after benchmark.

The complete direct-identity rewrite remains unshipped. A further prototype should keep the initial graph in an ordinary structured-clone representation and establish correspondence during the required traversal, rather than expand every field into separate wire records. It also needs a validation design that can reuse already established subtree facts across wrapper replacement. Those are explicit unresolved requirements, not reasons to drop type checks or the library's data.
