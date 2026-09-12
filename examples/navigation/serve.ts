import { installNavigationFrame } from '../../src/navigation-frame'
import { installNavigationHost } from '../../src/navigation-host'

const origin = 'http://localhost:8910'
const builds = [{ origin: 'http://localhost:8911', id: 'example-a', label: 'A' }, { origin: 'http://localhost:8912', id: 'example-b', label: 'B' }]
for (const [index, build] of builds.entries()) {
  Bun.serve({ hostname: '127.0.0.1', port: 8911 + index, fetch(request) {
    if (new URL(request.url).pathname === '/navigation.js') return new Response('(' + installNavigationFrame.toString() + ')(' + JSON.stringify({ reviewer: origin, build: build.id }) + ')', { headers: { 'Content-Type': 'text/javascript' } })
    return new Response(`<!doctype html><html><head><title>Navigation ${build.label}</title><script src="/navigation.js"></script><style>body{font:16px system-ui;background:white;color:#222;padding:20px}button,a,input{margin:8px}</style></head><body>
<h1>Build ${build.label}</h1><pre id="route"></pre><label>Local draft <input id="draft" value="Original ${build.label}"></label>
<button id="push">Open detail with local route state</button><button id="replace">Replace query</button><button id="back">App Back</button>
<p><a href="/article?view=full#section">Load another document</a><a href="#section">Jump to section</a></p>
<form action="/search"><input name="q" value="some words"><button>Search</button></form><div style="height:100vh"></div><h2 id="section">Section</h2>
<script>function render(){document.querySelector('#route').textContent=location.pathname+location.search+location.hash+'\\nLocal route state: '+JSON.stringify(history.state)}
render();addEventListener('popstate',render);addEventListener('hashchange',render);
document.querySelector('#push').onclick=()=>{history.pushState({detail:'${build.label}'},'', '/detail?view=one');render()};
document.querySelector('#replace').onclick=()=>{history.replaceState(history.state,'', '/detail?view=two');render()};
document.querySelector('#back').onclick=()=>history.back();</script></body></html>`, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "frame-ancestors " + origin } })
  } })
}
Bun.serve({ hostname: '127.0.0.1', port: 8910, fetch() {
  const script = '(' + installNavigationHost.toString() + ')(' + JSON.stringify({ builds }) + ')'
  return new Response(`<!doctype html><meta charset="utf-8"><title>Navigation comparison</title><style>body{margin:0;font:14px system-ui}header{height:76px;display:flex;align-items:center;gap:20px;padding:0 20px}#builds{display:flex;gap:10px;align-items:center}button[aria-pressed=true]{font-weight:bold}iframe{position:absolute;left:0;top:76px;width:100%;height:calc(100vh - 76px);border:0;visibility:hidden}iframe.active{visibility:visible}</style><header><strong>Navigation comparison</strong><nav id="builds"></nav><span id="status"></span></header><script>${script}</script>`, { headers: { 'Content-Type': 'text/html' } })
} })
console.log(origin + '/article?view=summary')
