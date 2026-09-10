# PReview

Compare React development builds while carrying compatible working state between them.

PReview keeps two to four builds mounted in separate iframes. An external Bun build plugin discovers React state, generates validators from TypeScript types, and instruments the browser bundle without editing the application's source files. Switching builds captures the current working state and restores compatible values through the destination's normal React setters.

**Experimental, local development tooling.** This is a working prototype, not universal state migration or a production browser extension. It requires source access and an instrumented development build. Pointing the wrapper at an arbitrary deployed website is not sufficient.

## Try it

Install [Bun](https://bun.sh), then:

```sh
bun install --frozen-lockfile
bun demo
```

Open **http://localhost:4510**. Edit the draft, change the tone, increment the count, or open the details and enter a note. Switch between the two build buttons; those values should travel with you. Continue editing and switch back.

The ref controls also exercise a shared object inside a Map and a memoized consumer of that Map. "Append ref without rendering" changes only the ref; switch builds to see the destination pick up the change. Use `PORT=4610 bun demo` to run a second example on ports 4610–4612.

"Edit saved result" exercises data whose type also permits an optional buffer. Ordinary results transfer as complete values. To check rejection, toggle a local resource in B, switch to A, then try B again: the destination resource stays local and A remains visible. Transfer details list cell identities and reasons without printing their values.

The self-contained example serves two visual variants of one small React app on ports 4511 and 4512. It needs no account, credentials, external services, or project-specific assets. These variants exercise the integration; they are not a claim of compatibility with every router or application.

### Try accelerated switching

```sh
bun examples/incremental/serve.ts
```

Open **http://localhost:4770**. This example enables the optional incremental engine and includes a 20,000-row feed, a draft, shared selection state, and edits made through old aliases and runtime-generated closures. Warm both directions before comparing switch times. Its **Comparison engine** control selects incremental or full checks in the same instrumented builds.

For an ordinary reviewer without write instrumentation, run `PREVIEW_INCREMENTAL=0 PORT=4760 bun examples/incremental/serve.ts`. This is a different control from selecting full checks inside an instrumented build.

The documented synthetic run measured about 23 ms warm switches versus 48 ms without instrumentation. Initial transfers and actual large-feed edits took hundreds of milliseconds. The generated-code parser adds about 4.2 MB minified and took 122–192 ms to load in that fixture; retained heap overhead is not isolated. These results describe this example, not every application. See the [complete measurements and limits](examples/incremental/README.md).

## Use with another application

Start with two checkouts of the same React/TypeScript application, each with its dependencies installed. Keep the application's existing build configuration in an external launcher. Add the plugin to each browser build:

```ts
import { previewPlugin } from '../PReview/src/plugin'

const checkout = '/path/to/application-checkout'
const { plugin, cells } = await previewPlugin(checkout, 'http://localhost:4510')

const result = await Bun.build({
  entrypoints: [checkout + '/src/client.tsx'],
  tsconfig: checkout + '/tsconfig.json',
  target: 'browser',
  plugins: [plugin],
  // Supply the app's usual public defines, loaders and styling plugins here.
})
```

The launcher owns entry points, HTML, CSS, assets, explicitly public environment values, and any backend proxy. PReview owns state discovery and instrumentation. Keep secret-bearing environment files out of browser defines. Do not bundle the observed runtime into production.

Some styling plugins inspect source through Bun's native parser hooks. PReview's `onLoad` transform can prevent those hooks from seeing application modules; this occurs with `bun-plugin-tailwind` 0.0.15. Generate CSS in a separate build from the untouched application, then serve that CSS with the instrumented JavaScript. Verify the rendered layout when composing build plugins.

Serve each result on a different localhost port, then run:

```sh
bun host http://localhost:4511/start http://localhost:4512/start
```

The initial path is configurable per build. The reviewer defaults to port 4510; `PORT` changes it. The origin supplied to `previewPlugin` must match the reviewer's actual origin exactly.

For applications that need HTTPS, serve the builds with trusted local certificates and launch the reviewer with your own certificate paths:

```sh
TLS_KEY=/path/to/localhost-key.pem TLS_CERT=/path/to/localhost-cert.pem \
  bun host https://localhost:4511/start https://localhost:4512/start
```

An HTTPS reviewer requires HTTPS builds. Certificates and keys are not included. The included launchers bind to localhost and reject unexpected request hosts. Multiplayer is not implemented.

This setup is once per application, outside its feature code. Individual PRs need no registration, manual state adapters, or source edits. The included launcher is an example, not a replacement for every application's development server.

To enable acceleration in a custom launcher, set `PREVIEW_INCREMENTAL=1` and load the incremental preload before all application code, as the [incremental launcher](examples/incremental/serve.ts) does. The preload requires the plugin's final write-coverage result. Setting the environment variable alone on a launcher without that preload is insufficient.

### Mount behind an existing authenticated server

`reviewerResponse({ origin, builds })` from `src/host.ts` creates a request handler for a configured HTTPS reviewer. Call it only after your server's access check. Give each build its own HTTPS origin and pass the reviewer's exact public origin to `previewPlugin`. TLS may terminate at your reverse proxy; the handler checks the configured host and does not trust forwarded host headers. It supplies a restrictive CSP and disables response caching.

The application owns login, access checks on HTML/assets/APIs, and a `frame-ancestors` policy allowing only its reviewer. PReview supplies no public proxy, deployment executor or authentication service.

For account-bound comparisons, pass `{ sessionModule: '/absolute/path/to/session.ts' }` as the plugin's third argument. That browser module exports `authorizeSession()`, returning `{ account: string, environment: string }` or a promise for it. Verify the current server session and reject anonymous users or a changed account relative to the loaded application. The bridge checks it before commands and rejects checkpoints or route preparation from another account/environment before applying state. Credentials must remain inside the application's normal authentication flow. Source capture and destination authentication start together. A per-request MessageChannel delivers the capture when ready; restoration waits for both that payload and fresh destination authorization. No authorization result is cached between switches.

**Transfer details** separates route waiting, command round trips (including session checks, bridge work, and messaging/queue overhead), and presentation. Capture and restore round trips overlap and must not be added together. Their breakdowns are nested inside those command times, not additional costs. `presentationMs` measures the synchronous change of the visible frame, not a paint acknowledgement; finishing and logging a transfer do not wait for animation frames in background tabs. `payloadWaitMs` measures the destination waiting for capture, overlapping its session check. Route preparation may run before the switch; only its remaining wait contributes to the switch total. Rejected and failed attempts retain their diagnostics. Index counts and timings are lifetime statistics except the current `indexedObjects`, `roots`, `pending`, `enabled` and `coverage` fields.

Use **Reload builds** after completing sign-in in separate build tabs. These are hosting integration primitives; the generic examples remain local, and deploying trusted builds behind an access gate is the launcher's responsibility.

## How state is matched

The compiler reads the checkout's `tsconfig.json` and examines source files under `src/`. It finds ordinary destructured `useState` calls and named `useRef` bindings, including their `React.*` spellings. Each cell is identified by its relative source path, owning function, and variable name. Matching identities, hook kinds and destination type validation determine what can transfer.

The runtime records mounted values and setters. It skips identities that already have multiple mounted instances at either end, clones accepted values, and restores them through normal React updates. Skipped destination identities remain excluded throughout the transfer, including remounts. A pending checkpoint initializes other newly mounted observed components. If a commit creates new ambiguity after state has been applied, the restore fails explicitly; it cannot claim those owners remained untouched. Object validation follows TypeScript structural compatibility: declared fields keep their types, while additional fields must contain plain transferable data. Additive properties survive a round trip through an older build without stripping or translating them. The destination validates one transfer plan, commits it, then repairs only cells changed by mounting or effects. Both passes share the restored object graph, so repaired cells retain aliases to unchanged refs. Rejections distinguish a changed hook kind, an invalid incoming value, an unsafe live ref, and ambiguity introduced during a commit. The acknowledgement contains cell identities, outcomes and timings; it does not recapture or return the destination state.

Each frame retains one complete checkpoint. Warm captures compare current values against it, validate changed cells, and send only those changes. With incremental observation enabled, a changed object, array or ordered Map can travel as a patch against that checkpoint. Unchanged descendants are reused without cloning or sending their contents; applying a patch creates new checkpoint containers and preserves shared references. New cells can refer into unchanged checkpoint data; references use a separate object-identity table, so application property names cannot collide with the protocol. The destination checks its live data too: hidden-build drift is repaired or rejected, rather than assumed unchanged. A missing checkpoint, including on a third build or after reload, requests a full transfer. A rejected restore retains one additional received checkpoint solely as a wire baseline, so another attempt can decode its delta without requesting the same full payload. Rejected data is not applied or marked valid; every retry still checks the destination schema and session. A successful restore or local capture replaces that baseline. Checkpoints and their lookup tables stay in page memory; there is no persistent snapshot history.

With incremental observation, capture constructs and validates the owned snapshot together and records its correspondence with live objects. Restoration records the objects it writes in that same index before React effects run, allowing checks and repairs to reuse unchanged subgraphs. Reference encoding uses existing parent links to skip unrelated checkpoint subtrees, with bounded temporary work and full traversal as a fallback. It adds no permanent index. The [large-transfer measurements](docs/large-transfers.md) document the improvement and remaining memory cost.

Comparisons share their work across refs during each synchronous read phase. Every React commit starts a fresh phase because effects can mutate any cell. When no repair commit occurs, verification reuses that phase's comparisons. Type-validation results are reused only for owned checkpoint copies under the same generated schema; mutable live values still require a fresh comparison or validation. Weak keys allow replaced checkpoint copies to be collected.

Refs are read from their current value at capture time, including in-place mutations since the last render. The checkpoint is cloned as one graph to retain shared references. Restoration reuses compatible mutable destination containers and schedules their owners to render, so existing Map references and memoized consumers continue to see changes. Read-only or incompatible containers are replaced. Pure handle refs stay local, including null DOM refs and empty callback arrays. Data containers may include unsupported optional or union branches, but their complete current values must validate at both ends; no fields are stripped.

The optional incremental engine adds compiler write markers, native mutation observation and interception of runtime-generated functions. It retains verified object correspondences for unchanged subgraphs and confirmed no-op writes. A real change invalidates the edited object and its ancestors while preserving independent unchanged descendants. New or unobserved data still requires full validation and copying. Detected eval and unsupported syntax disable acceleration. Code outside the observed bundle and native boundaries can evade it; this is not universal JavaScript mutation tracking.

The reviewer gives each build one endpoint of a private `MessageChannel`. The source sends checkpoint data directly to the destination; the reviewer receives only capture metadata and the restore outcome. This avoids cloning and retaining a second full payload in the reviewer. Both build requests still authenticate independently, and the destination checks the snapshot account/environment before applying it. Ports close on completion, failure or payload timeout. Capture and restore requests have a 60-second deadline so large initial transfers are not discarded by the short control-command timeout; this does not make those transfers faster. PReview does not upload checkpoints to a server. `window.lastTransfer` contains the latest outcome and timing record, not a standalone snapshot. Checkpoint data remains in the frames' memory. Hosting application code is a separate deployment step owned by your launcher.

**Copy details** copies the latest report, including a page-session ID and transfer sequence. Detailed JSON is generated when opened or copied. The reviewer does not serialize the full diagnostic report after every closed-panel switch.

Hosted integrations can opt into timing logs through `reviewerResponse({ origin, builds, transferLog: { endpoint: '/api/transfers', buildIds: ['build-a', 'build-b'] } })`. The endpoint must share the reviewer's origin; provide one opaque ID per build. Logging is off by default. The caller owns endpoint authentication, request-size limits, storage and retention. Parse incoming JSON with `parseTransferLog` from `src/transfer-log.ts` before storing it; the parser reconstructs an allowlist of timings, numeric counts, index metrics, build IDs and session/sequence identifiers. It excludes application values, cell paths, routes, raw error messages and previous reports.

Each completed, rejected or failed attempt schedules one small upload after presentation. It does not wait for the upload, queues no retries, and permits at most four requests in flight with ten-second timeouts. Return HTTP 204 after accepting the log. Transfer details shows **Timing saved** on acknowledgement or an explicit unsaved message on failure; copying remains available. Command round trips overlap, and index counters retain the lifetime semantics described above. Capture details separate validation/copying, wire encoding, checkpoint assembly, root ownership and sending (the existing field names are retained); repair details separate checking, indexing and committing. Counts distinguish copied objects, patched containers and explicit reused references (unchanged children omitted by a patch are not counted). When available, `heapBytes` is a browser heap sample, not an allocation count or an isolated per-frame measurement. Logged rejection reasons and phases use fixed enums; cell identities remain in the local report only.


## Current limits

- Supports `useState` and `useRef` values described by supported primitive, literal, union, array, fixed-tuple, Map, Set and plain-object types, including object intersections and mapped properties. `unknown` fields must pass the same plain-data checks at runtime; `any` remains unsupported. Type compatibility does not prove semantic compatibility across different code.
- Maps require primitive keys. PReview preserves aliases within the observed graph, but cannot generally repair unobserved closures or memoized values derived from an earlier version of that graph.
- Reducers, external stores, classes, functions, typed buffers, files and browser resources are not transferred. Cyclic graphs and accessor-backed objects are rejected. Resource-containing refs stay local as a whole; this can also exclude otherwise ordinary data beside a resource.
- Canvas resources and state declared beside a detected canvas owner stay in their original build. Setters used only inside effects are also excluded by a heuristic.
- State in repeated instances of the same component is skipped when its identity is ambiguous. Renames and moved declarations change identity. Aliased hook imports and other hook calling conventions are not recognized.
- Routing currently assumes a unique observed state value corresponding to `history.state` and an app that handles `popstate`. It intercepts History API methods to keep a separate navigation journal for each iframe. This is not a general router adapter and does not preserve arbitrary browser navigation behavior.
- Scroll restoration handles scroll containers with unique element IDs. It first tries a visible link anchor, then falls back to pixels. It does not make independently loaded feeds identical.
- Route preparation and restoration explicitly flush React commits, so hidden builds do not depend on animation frames. This does not wait for application-specific asynchronous work; later effects or responses may overwrite restored state. A failed restore can leave the hidden destination partially updated; there is no transaction rollback.
- Copyable data can still represent a request flag, timer ID or mutation receipt. The observer does not infer all of these meanings from a primitive type. Restore between settled builds; ref support does not move in-flight work or provide execution-state migration.
- Ordinary warm comparisons inspect mutable data to catch changes made without rendering. The optional incremental engine can reuse verified unchanged subgraphs within its observation boundary. Patching a large container still scans or shallow-copies its entries. New data and builds without a shared checkpoint can still require a full transfer. This is not constant-time synchronization.
- Builds remain mounted, so their effects, network connections and memory use remain active. This is not a suspension mechanism. Bundle generation runs once at startup; hot reload is not implemented.

## Trust and authentication

Use trusted builds that are allowed to see the same working state. Transferred drafts and other application data become available to the destination build and reviewer. Source/origin checks prevent unrelated windows from participating; they do not make an untrusted build safe.

The compiler excludes filenames containing `auth`, `compliance`, `tracing` or `analytics`. This is a discovery heuristic, **not a guarantee that all sensitive values are excluded**. Inspect the returned `cells` inventory and the application's state before using it with sensitive sessions. Both kinds of observed cell can hold sensitive data; wrapping a ref does not make its value shareable with another account.

PReview does not copy cookies, localStorage or sessionStorage and does not implement sign-in. Existing application authentication still applies. Localhost cookies may already be shared across ports, while origin-scoped storage is separate. The launcher must respect the application's normal authentication boundaries.

## Development

```sh
bun check
```

This runs the regression suite, strict TypeScript checks for the TypeScript sources, and linting. The browser runtime and inline host script are JavaScript; the TypeScript check does not cover them. Runtime regression tests exercise the actual restore code with controlled commit callbacks, including selective repairs and compact results. Browser checks exercise the real React renderer.

The value tests cover Map and tuple validation, container identity, shared references, subsequent mutation, and rejection of executable data. See [architecture notes](docs/architecture.md) for the compiler-versus-fiber tradeoff.

The reviewer enables a build after its observer has mounted, reports failed route preparation and runtime errors, and keeps the source visible when destination validation rejects the checkpoint. This initial mount check does not mean all network activity has settled. The programmatic `startReviewer` API takes `builds: [{ url, label }, ...]`; the CLI uses origins as labels.

The package uses TypeScript 5 for its compiler API and TypeScript 7 for checking. React and React DOM resolve from the target application's dependencies when integrating the plugin. This repository is used from source; it is not published to npm.

The working compiler, runtime, host and incremental engine live in `src/`; runnable demonstrations live in `examples/`. Retired fiber and shadow-observer investigations are preserved in Git history and are not part of the library tree.
