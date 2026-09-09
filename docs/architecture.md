# Why keep the compiler boundary?

Runtime fiber inspection is a credible alternative. [Bippy](https://github.com/aidenybai/bippy) exposes the fiber tree and renderer, and its documented setup installs instrumentation before React. A runtime adapter could avoid PReview's AST rewrite, but it would still need a way to load its observer and identify equivalent component instances across builds.

PReview currently uses source path, owner and binding name plus TypeScript-derived validators. Inserting a hook earlier in a component does not renumber those identities. They still change when declarations move or are renamed, and repeated component instances remain ambiguous.

Earlier investigations tested a hybrid: retain compiler identities and schemas, then use React's DevTools hook to observe commits and locate state overrides. The synthetic builds deliberately had different hook order. The retired probes remain in Git history.

Fiber events cannot observe writes inside mutable ref data made without a React update. Proxy interception also missed raw aliases retained before wrapping and raw objects inserted later. Those misses prevented using those probes as authority for unchanged values. Runtime inspection does not by itself resolve shared-reference identity, async ownership, or cross-build semantic compatibility.

The implemented optional acceleration instead combines compiler write markers, native mutation observation and generated-function instrumentation. Verified unchanged roots can retain their comparison mappings; actual changes require full comparison or copying. This retains source identity and TypeScript validation without proxying application data or depending on React fibers. Its [example and measured limits](../examples/incremental/README.md) describe the observation boundary and remaining costs.

The [large-transfer investigation](large-transfers.md) measures cold-transfer memory and phase costs, records limited prototype gains, and documents the implemented consolidation of capture, reconciliation and indexing around one correspondence owner. The synthetic improvement does not establish a fix for large application workloads.
