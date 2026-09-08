import { localURL, localPort } from './local'
import { buildURL, deploymentOrigin } from './origin'

type ReviewerOptions = { port: number; builds: { url: string; label: string }[]; tls?: { key: string; cert: string } }

// The caller owns authentication and routing. Mount only after its access gate.
export function reviewerResponse(options: { origin: string; builds: { url: string; label: string }[] }) {
const ownOrigin = deploymentOrigin(options.origin)
const builds = options.builds.map(build => buildURL(build.url))
const origins = builds.map(url => url.origin)
if (origins.length < 2 || origins.length > 4 || new Set(origins).size !== origins.length || origins.includes(ownOrigin)) {
  throw new Error('Provide two to four distinct build origins, separate from the reviewer')
}
if (ownOrigin.startsWith('https:') && builds.some(url => url.protocol !== 'https:')) throw new Error('An HTTPS reviewer needs HTTPS builds')

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PReview</title><style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#161719;color:#eee}
header{height:58px;display:flex;align-items:center;gap:12px;padding:12px}
button,select{font:inherit;padding:8px 14px;border:1px solid #777;border-radius:7px;background:#292b30;color:inherit;cursor:pointer;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button:disabled{opacity:.5;cursor:wait}header strong{flex-shrink:0}
button[aria-pressed=true]{background:#eef;color:#112}
iframe{position:absolute;top:58px;left:0;width:100%;height:calc(100vh - 58px);border:0;visibility:hidden}
iframe.active{visibility:visible}#status{font-size:12px}
details{position:absolute;z-index:2;right:12px;top:66px;background:#292b30;border:1px solid #777;border-radius:7px;padding:8px;max-width:min(620px,90vw)}summary{cursor:pointer}pre{max-height:65vh;overflow:auto;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><header><strong>PReview</strong><span id="status" role="status">Connecting to builds…</span></header><details id="details" hidden><summary>Transfer details</summary><pre id="report"></pre></details>
<script type="module">
const origins = ${JSON.stringify(origins)};
const urls = ${JSON.stringify(builds.map(url => url.href)).replaceAll('<', '\\u003c')};
const labels = ${JSON.stringify(options.builds.map(build => build.label)).replaceAll('<', '\\u003c')};
const header = document.querySelector('header'), status = document.querySelector('#status');
const frames = [], buttons = [], capabilities = [];
const reload = document.createElement('button'); reload.textContent = 'Reload builds';
reload.addEventListener('click', () => { if (!busy) location.reload(); }); header.insertBefore(reload, status);
const benchmarkRecords = [];
const engine = document.createElement('select'); engine.setAttribute('aria-label', 'Comparison engine');
engine.innerHTML = '<option value="incremental">Incremental</option><option value="full">Full checks</option>'; engine.hidden = true; header.insertBefore(engine, status);
engine.addEventListener('change', async () => {
  if (busy) return;
  busy = true; engine.disabled = true;
  try {
    const results = await Promise.all(frames.map((frame, index) => call(index, 'engine', engine.value)));
    if (engine.value === 'incremental' && results.some(result => !result.enabled)) {
      await Promise.all(frames.map((frame, index) => call(index, 'engine', 'full')));
      engine.value = 'full'; status.textContent = 'Full checks required: unobserved code ran';
    } else status.textContent = engine.value === 'full' ? 'Full checks enabled' : 'Incremental enabled · warm both builds';
  } catch (error) { status.textContent = error.message; } finally { busy = false; engine.disabled = false; }
});
let active = 0, sequence = 0, busy = false;
const pending = new Map();
for (let index = 0; index < origins.length; index++) {
  const button = document.createElement('button');
  button.textContent = labels[index];
  button.title = labels[index] + ' · ' + origins[index];
  button.disabled = true;
  button.setAttribute('aria-pressed', String(index === 0));
  button.addEventListener('click', () => swap(index));
  header.insertBefore(button, status);
  buttons.push(button);
  const frame = document.createElement('iframe');
  frame.addEventListener('load', async () => {
    button.disabled = true;
    try {
      const result = await call(index, 'ready');
      if (!result.ready) throw Error('Application has not mounted');
      button.disabled = false;
      capabilities[index] = result.incremental;
      engine.hidden = !buttons.every((button, position) => !button.disabled && capabilities[position] !== undefined);
      if (!engine.hidden && !capabilities.every(item => item.enabled)) engine.value = 'full';
      status.textContent = buttons.every(button => !button.disabled) ? 'Builds ready · canvas stays local' : 'Connecting to remaining builds…';
    } catch (error) { status.textContent = labels[index] + ': ' + error.message; }
  });
  frame.title = 'Build ' + origins[index];
  frame.src = urls[index];
  if (index === 0) frame.classList.add('active');
  document.body.append(frame);
  frames.push(frame);
}
const preparations = frames.map(() => ({ promise: Promise.resolve(), error: null, commands: [] }));
addEventListener('message', event => {
  if (event.data?.channel !== 'preview-navigation') return;
  const index = frames.findIndex(frame => frame.contentWindow === event.source);
  if (index !== active || event.origin !== origins[index]) return;
  for (let target = 0; target < frames.length; target++) {
    if (target === index) continue;
    const preparation = { promise: null, error: null, commands: [] };
    preparation.promise = call(target, 'prepare', event.data.history, preparation.commands).then(result => { preparation.error = result.navigated ? null : Error('Destination could not follow this route'); }, error => { preparation.error = error; });
    preparations[target] = preparation;
  }
});
addEventListener('message', event => {
  const message = event.data;
  if (message?.channel !== 'preview-state') return;
  const request = pending.get(message.id);
  if (!request || event.source !== frames[request.index].contentWindow || event.origin !== origins[request.index]) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  request.finish(typeof message.error === 'string' ? Error(message.error) : null, message.result, message.timing);
});
function call(index, operation, snapshot, commands) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const finish = (error, result, timing) => {
      const roundTripMs = performance.now() - started;
      if (commands !== undefined) commands.push({ build: index, operation, roundTripMs, ...timing,
        transportAndQueueMs: timing === undefined ? undefined : Math.max(0, roundTripMs - timing.sessionMs - timing.operationMs),
        error: error?.message });
      if (error !== null) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { pending.delete(id); finish(Error(operation === 'ready' ? 'Application did not mount; check its login and backend connection' : 'Build did not respond to ' + operation)); }, operation === 'ready' ? 30000 : 5000);
    pending.set(id, { index, finish, timer });
    try { frames[index].contentWindow.postMessage({ channel: 'preview-state', id, operation, snapshot }, origins[index]); }
    catch (error) { pending.delete(id); clearTimeout(timer); finish(error); }
  });
}
async function swap(index) {
  if (index === active || busy) return;
  busy = true; engine.disabled = true;
  const started = performance.now();
  const record = { source: active, destination: index, engine: engine.value, outcome: 'error', result: null, error: null, milliseconds: 0,
    timing: { routeWaitMs: 0, commands: [], presentationMs: 0 } };
  let snapshot = null;
  status.textContent = 'Transferring…';
  try {
    const preparation = preparations[index];
    await preparation.promise;
    record.timing.routeWaitMs = performance.now() - started;
    // Preparation can precede the click. Only routeWaitMs belongs in the switch
    // total; its command timings explain the work that was already in flight.
    record.timing.routePreparation = preparation.commands;
    if (preparation.error !== null) throw preparation.error;
    snapshot = await call(active, 'capture', undefined, record.timing.commands);
    let result = await call(index, 'restore', snapshot, record.timing.commands);
    if (result.needsFull) {
      snapshot = await call(active, 'checkpoint', undefined, record.timing.commands);
      result = await call(index, 'restore', snapshot, record.timing.commands);
    }
    record.result = result;
    record.engine = snapshot.incremental?.enabled ? 'incremental' : 'full';
    if (result.rejected.length) {
      record.outcome = 'rejected';
      status.textContent = 'Rejected ' + result.rejected.length + ' incompatible cells; kept source visible';
      return;
    }
    const presenting = performance.now();
    frames[active].classList.remove('active');
    buttons[active].setAttribute('aria-pressed', 'false');
    active = index;
    frames[active].classList.add('active');
    buttons[active].setAttribute('aria-pressed', 'true');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    record.timing.presentationMs = performance.now() - presenting;
    record.outcome = 'restored';
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    status.textContent = record.error;
  } finally {
    record.milliseconds = performance.now() - started;
    const result = record.result;
    benchmarkRecords.push({ source: record.source, destination: index, engine: record.engine, outcome: record.outcome,
      milliseconds: record.milliseconds, rejected: result?.rejected.length, changed: result?.changed?.length, error: record.error });
    if (benchmarkRecords.length > 100) benchmarkRecords.shift();
    window.lastTransfer = record;
    document.querySelector('#details').hidden = false;
    document.querySelector('#report').textContent = JSON.stringify({ milliseconds: record.milliseconds, engine: record.engine, outcome: record.outcome, error: record.error,
      sourceIndex: snapshot?.incremental, destinationIndex: result?.incremental,
      indexStatistics: 'Current: indexedObjects, roots, pending, enabled, coverage. Other index counters and timings accumulate for the lifetime of each build.',
      restored: result?.restored, absent: result?.absent, rejected: result?.rejected, rejectionDetails: result?.rejectionDetails,
      secondPass: result?.secondPass, changed: result?.changed, retained: result?.retained, transferred: result?.transferred,
      keptLocal: { source: snapshot?.skipped, destination: result?.skipped },
      timing: { ...record.timing, capture: { captureMs: snapshot?.captureMs, comparisonMs: snapshot?.comparisonMs }, restore: result?.timing }, recent: benchmarkRecords }, null, 2);
    if (record.outcome === 'restored') status.textContent = result.restored.length + ' cells · ' + result.absent.length + ' absent · '
      + (result.skipped.length ? result.skipped.length + ' kept local · ' : '')
      + (result.changed.length ? result.changed.length + ' changed during restore · ' : '')
      + Math.round(record.milliseconds) + ' ms';
    busy = false; engine.disabled = false;
  }
}

</script></body></html>`

const script = html.slice(html.indexOf('<script type="module">') + '<script type="module">'.length, html.indexOf('</script>'))
const hash = new Bun.CryptoHasher('sha256').update(script).digest('base64')
return (request: Request) => {
  // A trusted reverse proxy may terminate TLS. Ignore forwarded host headers.
  if (new URL(request.url).host !== new URL(ownOrigin).host) return new Response('Unexpected host', { status: 403 })
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'sha256-" + hash + "'; style-src 'unsafe-inline'; frame-src " + origins.join(' ') + "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  } })
}
}

export function startReviewer(options: ReviewerOptions) {
const port = localPort(String(options.port))
const ownOrigin = (options.tls === undefined ? 'http' : 'https') + '://localhost:' + port
const respond = reviewerResponse({ origin: ownOrigin, builds: options.builds.map(build => ({ ...build, url: localURL(build.url).href })) })
const server = Bun.serve({
  hostname: 'localhost', port,
  ...(options.tls === undefined ? {} : { tls: { key: Bun.file(options.tls.key), cert: Bun.file(options.tls.cert) } }),
  fetch: respond,
})
console.log('PReview ready:', ownOrigin)
return server
}

if (import.meta.main) {
  const key = process.env['TLS_KEY'], cert = process.env['TLS_CERT']
  if ((key === undefined) !== (cert === undefined)) throw new Error('Set both TLS_KEY and TLS_CERT, or neither')
  startReviewer({
    port: localPort(process.env['PORT'] ?? '4510'),
    builds: process.argv.slice(2).map(url => ({ url, label: localURL(url).origin })),
    ...(key === undefined || cert === undefined ? {} : { tls: { key, cert } }),
  })
}
