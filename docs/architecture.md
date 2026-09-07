# Why keep the compiler boundary?

Runtime fiber inspection is a credible alternative. [Bippy](https://github.com/aidenybai/bippy) exposes the fiber tree and renderer, and its documented setup installs instrumentation before React. A runtime adapter could avoid PReview's AST rewrite, but it would still need a way to load its observer and identify equivalent component instances across builds.

PReview currently uses source path, owner and binding name plus TypeScript-derived validators. Inserting a hook earlier in a component does not renumber those identities. They still change when declarations move or are renamed, and repeated component instances remain ambiguous.

Keep the current approach while build integration is manageable. If adoption shows that this integration is the main obstacle, evaluate a fiber-backed adapter against the same restoration examples, including changed hook order, repeated instances and resource-owning refs. Runtime inspection does not by itself resolve shared-reference identity, async ownership, or cross-build semantic compatibility.

No fiber dependency is added by the ref implementation.
