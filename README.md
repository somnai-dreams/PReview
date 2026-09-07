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

The self-contained example serves two visual variants of one small React app on ports 4511 and 4512. It needs no account, credentials, external services, or project-specific assets. These variants exercise the integration; they are not a claim of compatibility with every router or application.

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

An HTTPS reviewer requires HTTPS builds. Certificates and keys are not included. All included servers bind to localhost and reject unexpected request hosts. Remote access, tunnels, hosted review sessions and multiplayer are not supported by this package yet.

This setup is once per application, outside its feature code. Individual PRs need no registration, manual state adapters, or source edits. The included launcher is an example, not a replacement for every application's development server.

## How state is matched

The compiler reads the checkout's `tsconfig.json` and examines source files under `src/`. It finds ordinary destructured `useState` or `React.useState` calls. Each state cell is identified by its relative source path, owning function, and variable name. Matching identities and destination type validation determine what can transfer.

The runtime records mounted values and setters. It skips ambiguous repeated instances, clones accepted values, and restores them through normal React updates. A pending checkpoint also initializes newly mounted observed components. A second pass follows mounting, and the wrapper reports restored, absent, rejected, and changed values.

No application source or runtime state is uploaded by PReview. State is exchanged directly between the localhost frames and their parent via `postMessage`. Debug snapshots remain accessible in the reviewer's page memory as `window.lastTransfer`.

## Current limits

- Supports ordinary `useState` values described by supported primitive, literal, union, array, Set and plain-object types. Type compatibility does not prove semantic compatibility across different code.
- Ref contents, Maps, reducers, external stores, classes, functions, opaque values, files and browser resources are not transferred. Feed data held in refs can therefore differ even when filters and scroll position transfer.
- Canvas resources and state declared beside a detected canvas owner stay in their original build. Setters used only inside effects are also excluded by a heuristic.
- State in repeated instances of the same component is skipped when its identity is ambiguous. Renames and moved declarations change identity. Aliased hook imports and other hook calling conventions are not recognized.
- Routing currently assumes a unique observed state value corresponding to `history.state` and an app that handles `popstate`. It intercepts History API methods to keep a separate navigation journal for each iframe. This is not a general router adapter and does not preserve arbitrary browser navigation behavior.
- Scroll restoration handles scroll containers with unique element IDs. It first tries a visible link anchor, then falls back to pixels. It does not make independently loaded feeds identical.
- Restoration uses frame timing, not application-specific readiness. Async effects may overwrite restored state later. A failed restore can leave the hidden destination partially updated; there is no transaction rollback.
- Builds remain mounted, so their effects, network connections and memory use remain active. This is not a suspension mechanism. Bundle generation runs once at startup; hot reload is not implemented.

## Trust and authentication

Use trusted builds that are allowed to see the same working state. Transferred drafts and other application data become available to the destination build and reviewer. Source/origin checks prevent unrelated windows from participating; they do not make an untrusted build safe.

The compiler excludes filenames containing `auth`, `compliance`, `tracing` or `analytics`. This is a discovery heuristic, **not a guarantee that all sensitive values are excluded**. Inspect the returned `cells` inventory and the application's state before using it with sensitive sessions.

PReview does not copy cookies, localStorage or sessionStorage and does not implement sign-in. Existing application authentication still applies. Localhost cookies may already be shared across ports, while origin-scoped storage is separate. The launcher must respect the application's normal authentication boundaries.

## Development

```sh
bun check
```

This runs the compiler regression test, strict TypeScript checks for the TypeScript sources, and linting. The browser runtime and inline host script are JavaScript; the TypeScript check does not cover them. Browser checks remain manual in this initial version.

The package uses TypeScript 5 for its compiler API and TypeScript 7 for checking. React is used by the example and must resolve from the target application's dependencies when integrating the plugin. This repository is used from source; it is not published to npm.
