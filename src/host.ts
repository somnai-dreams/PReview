import { localURL, localPort } from './local'
import { buildURL, deploymentOrigin } from './origin'
import { parseTransferLog } from './transfer-log'

type ReviewerOptions = { port: number; builds: { url: string; label: string }[]; tls?: { key: string; cert: string } }

// The caller owns authentication and routing. Mount only after its access gate.
export function reviewerResponse(options: { origin: string; builds: { url: string; label: string }[]; transferLog?: { endpoint: string; buildIds: string[] } }) {
const ownOrigin = deploymentOrigin(options.origin)
const builds = options.builds.map(build => buildURL(build.url))
const origins = builds.map(url => url.origin)
if (origins.length < 2 || origins.length > 4 || new Set(origins).size !== origins.length || origins.includes(ownOrigin)) {
  throw new Error('Provide two to four distinct build origins, separate from the reviewer')
}
if (ownOrigin.startsWith('https:') && builds.some(url => url.protocol !== 'https:')) throw new Error('An HTTPS reviewer needs HTTPS builds')

const logging = options.transferLog
if (logging !== undefined) {
  const endpoint = new URL(logging.endpoint, ownOrigin)
  if (endpoint.origin !== ownOrigin || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') throw new Error('Transfer logs require a same-origin endpoint without query parameters')
  if (logging.buildIds.length !== builds.length || new Set(logging.buildIds).size !== builds.length || logging.buildIds.some(id => !/^[a-zA-Z0-9._-]{1,80}$/.test(id))) throw new Error('Provide one distinct opaque log ID per build')
}

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PReview</title><style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#161719;color:#eee}
header{height:58px;display:flex;align-items:center;gap:12px;padding:12px}
button,select{font:inherit;padding:8px 14px;border:1px solid #777;border-radius:7px;background:#292b30;color:inherit;cursor:pointer;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button:disabled{opacity:.5;cursor:wait}header strong{flex-shrink:0}
button[aria-pressed=true]{background:#eef;color:#112}
iframe{position:absolute;top:58px;left:0;width:100%;height:calc(100vh - 58px);border:0;visibility:hidden}
iframe.active{visibility:visible}#status{font-size:12px}
details{position:absolute;z-index:2;right:12px;top:66px;background:#292b30;border:1px solid #777;border-radius:7px;padding:8px;max-width:min(620px,90vw)}summary{cursor:pointer}#detail-actions{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px}pre{max-height:65vh;overflow:auto;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><header><strong>PReview</strong><span id="status" role="status">Connecting to builds…</span></header><details id="details" hidden><summary>Transfer details</summary><div id="detail-actions"><button id="copy-details" type="button">Copy details</button><span id="copy-status" role="status"></span><span id="log-status" role="status"></span></div><pre id="report"></pre></details>
<script type="module">
const origins = ${JSON.stringify(origins)};
const urls = ${JSON.stringify(builds.map(url => url.href)).replaceAll('<', '\\u003c')};
const labels = ${JSON.stringify(options.builds.map(build => build.label)).replaceAll('<', '\\u003c')};
const header = document.querySelector('header'), status = document.querySelector('#status');
const frames = [], buttons = [], capabilities = [];
const reload = document.createElement('button'); reload.textContent = 'Reload builds';
reload.addEventListener('click', () => { if (!busy) location.reload(); }); header.insertBefore(reload, status);
const benchmarkRecords = [];
const logConfig = ${JSON.stringify(logging === undefined ? null : { endpoint: new URL(logging.endpoint, ownOrigin).pathname, buildIds: logging.buildIds })};
const parseTransferLog = ${parseTransferLog.toString()};
const session = crypto.randomUUID();
const details = document.querySelector('#details'), report = document.querySelector('#report');
const copyButton = document.querySelector('#copy-details'), copyStatus = document.querySelector('#copy-status'), logStatus = document.querySelector('#log-status');
let latestReport = null, transferSequence = 0, loggingRequests = 0;
function renderReport() { if (latestReport !== null) report.textContent = JSON.stringify(latestReport, null, 2); }
details.addEventListener('toggle', () => { if (details.open) renderReport(); });
copyButton.addEventListener('click', async () => {
  if (latestReport === null) return;
  try { await navigator.clipboard.writeText(JSON.stringify(latestReport, null, 2)); copyStatus.textContent = 'Copied'; }
  catch { copyStatus.textContent = 'Copy unavailable; select the details below'; renderReport(); }
});
function logTransfer(report, source, destination) {
  if (logConfig === null) return;
  const status = text => { if (latestReport === report) logStatus.textContent = text; };
  if (loggingRequests >= 4) { status('Timing not saved: logger busy'); return; }
  loggingRequests++;
  // Run after presentation; no snapshots, cell identities, raw errors or history
  // enter this bounded request. Failed uploads never delay or retry a switch.
  setTimeout(async () => {
    try {
      const command = item => ({ ...item, failed: item.error !== undefined });
      const reasons = report.rejectionDetails ?? [];
      const frequencies = (key, values) => Object.fromEntries(values.map(value => [value, reasons.filter(item => item[key] === value).length]));
      const payload = parseTransferLog({ version: 1, session, sequence: report.transfer.sequence, builds: logConfig.buildIds,
        source, destination, engine: report.engine, outcome: report.outcome, milliseconds: report.milliseconds,
        counts: { restored: report.restored?.length, absent: report.absent?.length, rejected: report.rejected?.length,
          secondPass: report.secondPass?.length, changed: report.changed?.length, retained: report.retained, transferred: report.transferred,
          sourceSkipped: report.keptLocal.source?.length, destinationSkipped: report.keptLocal.destination?.length,
          copiedObjects: report.timing.capture.copiedObjects, patchedObjects: report.timing.capture.patchedObjects,
          reusedObjects: report.timing.capture.reusedObjects, heapBytes: report.timing.capture.heapBytes },
        rejectionReasons: frequencies('reason', ['hook-kind-mismatch', 'incoming-value-invalid', 'live-ref-invalid', 'multiple-instances-after-commit']),
        rejectionPhases: frequencies('phase', ['validation', 'repair', 'verification']),
        sourceIndex: report.sourceIndex ?? null, destinationIndex: report.destinationIndex ?? null,
        timing: { ...report.timing, ...report.timing.capture, ...report.timing.restore,
          commands: report.timing.commands.map(command), routePreparation: (report.timing.routePreparation ?? []).map(command) } });
      const response = await fetch(logConfig.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), keepalive: true, signal: AbortSignal.timeout(10000) });
      if (response.status !== 204) throw Error('Timing upload failed');
      status('Timing saved');
    } catch { status('Timing not saved; use Copy details'); }
    finally { loggingRequests--; }
  }, 0);
}
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
function call(index, operation, snapshot, commands, port) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const finish = (error, result, timing) => {
      const roundTripMs = performance.now() - started;
      if (commands !== undefined) commands.push({ build: index, operation, roundTripMs, ...timing,
        transportAndQueueMs: timing === undefined ? undefined : Math.max(0, roundTripMs - Math.max(timing.sessionMs, timing.payloadWaitMs ?? 0) - timing.operationMs),
        error: error?.message });
      if (error !== null) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { pending.delete(id); finish(Error(operation === 'ready' ? 'Application did not mount; check its login and backend connection' : 'Build did not respond to ' + operation)); }, operation === 'ready' ? 30000 : ['capture', 'checkpoint', 'restore'].includes(operation) ? 60000 : 5000);
    pending.set(id, { index, finish, timer });
    try {
      frames[index].contentWindow.postMessage({ channel: 'preview-state', id, operation, snapshot }, origins[index], port === undefined ? [] : [port]);
    }
    catch (error) { port?.close(); pending.delete(id); clearTimeout(timer); finish(error); }
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
    // The parent hands each endpoint directly to a build. Job data is cloned
    // once between the builds and never enters the reviewer's JavaScript heap.
    async function transfer(operation) {
      const channel = new MessageChannel();
      const restored = call(index, 'restore', undefined, record.timing.commands, channel.port2);
      const captured = call(active, operation, undefined, record.timing.commands, channel.port1)
        .then(metadata => { snapshot = metadata; return metadata; });
      const [, result] = await Promise.all([captured, restored]);
      return result;
    }
    let result = await transfer('capture');
    if (result.needsFull) result = await transfer('checkpoint');
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
    // React already committed. Finishing must not depend on paint callbacks,
    // which browsers suspend when the reviewer is in a background tab.
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
    latestReport = { transfer: { session, sequence: ++transferSequence }, milliseconds: record.milliseconds, engine: record.engine, outcome: record.outcome, error: record.error,
      sourceIndex: snapshot?.incremental, destinationIndex: result?.incremental,
      indexStatistics: 'Current: indexedObjects, roots, pending, enabled, coverage. Other index counters and timings accumulate for the lifetime of each build.',
      restored: result?.restored, absent: result?.absent, rejected: result?.rejected, rejectionDetails: result?.rejectionDetails,
      secondPass: result?.secondPass, changed: result?.changed, retained: result?.retained, transferred: result?.transferred,
      keptLocal: { source: snapshot?.skipped, destination: result?.skipped },
      timing: { ...record.timing, capture: { captureMs: snapshot?.captureMs, comparisonMs: snapshot?.comparisonMs, ...snapshot?.captureDetails }, restore: result?.timing }, recent: benchmarkRecords.slice() };
    details.hidden = false; copyStatus.textContent = '';
    logStatus.textContent = logConfig === null ? '' : 'Saving timing…';
    if (details.open) renderReport(); else report.textContent = '';
    logTransfer(latestReport, record.source, record.destination);
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
    'content-security-policy': "default-src 'none'; script-src 'sha256-" + hash + "'; " + (logging === undefined ? '' : "connect-src 'self'; ") + "style-src 'unsafe-inline'; frame-src " + origins.join(' ') + "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
