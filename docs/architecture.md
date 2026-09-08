# Why keep the compiler boundary?

Runtime fiber inspection is a credible alternative. [Bippy](https://github.com/aidenybai/bippy) exposes the fiber tree and renderer, and its documented setup installs instrumentation before React. A runtime adapter could avoid PReview's AST rewrite, but it would still need a way to load its observer and identify equivalent component instances across builds.

PReview currently uses source path, owner and binding name plus TypeScript-derived validators. Inserting a hook earlier in a component does not renumber those identities. They still change when declarations move or are renamed, and repeated component instances remain ambiguous.

The [fiber experiment](../experiments/fiber/README.md) now tests a hybrid: retain these compiler identities and schemas, then use React's DevTools hook to observe commits and locate state overrides. Its synthetic builds deliberately have different hook order. This gives us an executable way to assess runtime behavior as well as adoption costs.

Fiber events cannot observe writes inside mutable ref data made without a React update. The experiment also tests proxy interception and preserves counterexamples involving raw aliases. Those misses prevent replacing full data checks with the current observer's change predictions. Runtime inspection does not by itself resolve shared-reference identity, async ownership, or cross-build semantic compatibility.

No fiber dependency is added to the default runtime. The experimental observer is loaded only by its explicit launcher.
