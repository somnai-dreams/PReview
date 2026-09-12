# Normal preview paths

Run `bun examples/navigation/serve.ts`, then open `http://localhost:8910/article?view=summary`.

The outer URL is the application path, query and fragment. Both builds start there. Try the detail button, document link, fragment link and search form; use browser Back/Forward and the app's Back button. Switch builds after navigating. A/B switching adds no browser history entry. Type a draft, open detail, switch to B, then return to A: A retains its draft and local route state while its document remains mounted. Document navigation loads normally and does not transfer unsaved work between builds.

`installNavigationHost` owns the outer history and accepts messages only from the configured frame windows, origins and build identities. `installNavigationFrame` runs before app code and keeps native route state inside each frame. It reports paths and opaque history-entry keys to the host. Ordinary links, client history operations, fragments and same-origin document navigations use replacement loads in the frame so hidden builds do not create browser Back entries. The Navigation API covers programmatic location changes and GET forms in supporting browsers; ordinary links and client history also work without that API. POST submissions and external destinations retain native handling.

The state-transfer runtime uses the installed frame history owner when present. A deployment can use this routing bridge without React, compiler instrumentation or state transfer. The example intentionally contains no state-transfer runtime.
