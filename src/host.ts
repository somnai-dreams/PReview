import { localURL, localPort } from './local'

type ReviewerOptions = { port: number; builds: { url: string; label: string }[]; tls?: { key: string; cert: string } }

export function startReviewer(options: ReviewerOptions) {
const port = localPort(String(options.port))
const builds = options.builds.map(build => localURL(build.url))
const origins = builds.map(url => url.origin)
const ownOrigin = (options.tls === undefined ? 'http' : 'https') + '://localhost:' + port
if (origins.length < 2 || origins.length > 4 || new Set(origins).size !== origins.length || origins.includes(ownOrigin)) {
  throw new Error('Provide two to four distinct build origins, separate from the reviewer')
}
if (options.tls !== undefined && builds.some(url => url.protocol !== 'https:')) throw new Error('An HTTPS reviewer needs HTTPS builds')

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PReview</title><style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#161719;color:#eee}
header{height:58px;display:flex;align-items:center;gap:12px;padding:12px}
button{font:inherit;padding:8px 14px;border:1px solid #777;border-radius:7px;background:#292b30;color:inherit;cursor:pointer;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
const frames = [], buttons = [];
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
      status.textContent = buttons.every(button => !button.disabled) ? 'Builds ready · canvas stays local' : 'Connecting to remaining builds…';
    } catch (error) { status.textContent = labels[index] + ': ' + error.message; }
  });
  frame.title = 'Build ' + origins[index];
  frame.src = urls[index];
  if (index === 0) frame.classList.add('active');
  document.body.append(frame);
  frames.push(frame);
}
const preparations = frames.map(() => Promise.resolve());
const preparationErrors = frames.map(() => null);
addEventListener('message', event => {
  if (event.data?.channel !== 'preview-navigation') return;
  const index = frames.findIndex(frame => frame.contentWindow === event.source);
  if (index !== active || event.origin !== origins[index]) return;
  for (let target = 0; target < frames.length; target++) {
    if (target === index) continue;
    preparations[target] = call(target, 'prepare', event.data.history).then(result => { preparationErrors[target] = result.navigated ? null : Error('Destination could not follow this route'); }, error => { preparationErrors[target] = error; });
  }
});
addEventListener('message', event => {
  const message = event.data;
  if (message?.channel !== 'preview-state') return;
  const request = pending.get(message.id);
  if (!request || event.source !== frames[request.index].contentWindow || event.origin !== origins[request.index]) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (typeof message.error === 'string') request.reject(Error(message.error));
  else request.resolve(message.result);
});
function call(index, operation, snapshot) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(operation === 'ready' ? 'Application did not mount; check its login and backend connection' : 'Build did not respond to ' + operation)); }, operation === 'ready' ? 30000 : 5000);
    pending.set(id, { index, resolve, reject, timer });
    frames[index].contentWindow.postMessage({ channel: 'preview-state', id, operation, snapshot }, origins[index]);
  });
}
async function swap(index) {
  if (index === active || busy) return;
  busy = true;
  const started = performance.now();
  status.textContent = 'Transferring…';
  try {
    await preparations[index];
    if (preparationErrors[index] !== null) throw preparationErrors[index];
    const snapshot = await call(active, 'capture');
    const result = await call(index, 'restore', snapshot);
    window.lastTransfer = { source: active, destination: index, snapshot, result, milliseconds: performance.now() - started };
    document.querySelector('#details').hidden = false;
    document.querySelector('#report').textContent = JSON.stringify({ restored: result.restored, absent: result.absent, rejected: result.rejected, changed: result.changed ?? [], keptLocal: snapshot.skipped, timing: { captureMs: snapshot.captureMs, ...result.timing } }, null, 2);
    if (result.rejected.length) {
      status.textContent = 'Rejected ' + result.rejected.length + ' incompatible or ambiguous cells; kept source visible';
      return;
    }
    frames[active].classList.remove('active');
    buttons[active].setAttribute('aria-pressed', 'false');
    active = index;
    frames[active].classList.add('active');
    buttons[active].setAttribute('aria-pressed', 'true');
    status.textContent = result.restored.length + ' cells · ' + result.absent.length + ' absent · '
      + (result.changed.length ? result.changed.length + ' changed during restore · ' : '')
      + Math.round(performance.now() - started) + ' ms';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
  }
}
</script></body></html>`

const server = Bun.serve({
  hostname: 'localhost', port,
  ...(options.tls === undefined ? {} : { tls: { key: Bun.file(options.tls.key), cert: Bun.file(options.tls.cert) } }),
  fetch(request) {
    if (new URL(request.url).origin !== ownOrigin) return new Response('Unexpected host', { status: 403 })
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  },
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
