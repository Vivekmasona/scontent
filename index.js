// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/control" });

const PORT = process.env.PORT || 3000;
let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      userDataDir: "/tmp/chrome-user-data",
    });
  }
  return browserPromise;
}

const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mkv|mp3|aac|ogg|opus|wav|flac|m4a|jpg|jpeg|png|gif|bmp|webp)(\?|$)/i;
function cleanURL(url) {
  try {
    const u = new URL(url);
    ["bytestart","byteend","range"].forEach(p=>u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

// In-memory SSE clients
const sseClients = new Set();
function sendSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch(_) { /* ignore */ }
  }
}

// Serve static dashboard + iframe client
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Live Puppeteer Mirror & Capture</title>
<style>
  body{margin:0;font-family:system-ui,Arial;background:linear-gradient(135deg,#3a1c71,#d76d77,#ffaf7b);color:#fff;display:flex;flex-direction:column;height:100vh;}
  header{padding:10px;background:rgba(0,0,0,0.25);display:flex;gap:12px;align-items:center;}
  .counts{display:flex;gap:8px;}
  .box{background:#ffffff22;padding:6px 10px;border-radius:8px;}
  #controls{margin-left:auto;display:flex;gap:8px;align-items:center;}
  main{display:flex;flex:1;gap:8px;padding:8px;}
  #left{flex:1;display:flex;flex-direction:column;gap:8px;}
  #iframeWrap{flex:1;background:#000;border-radius:8px;overflow:hidden;border:2px solid rgba(255,255,255,0.08);}
  iframe{width:100%;height:100%;border:0;}
  #cards{height:40vh;overflow:auto;padding:8px;background:rgba(0,0,0,0.12);border-radius:8px;}
  .card{background:#ffffff11;color:#fff;padding:8px;border-radius:6px;margin-bottom:8px;font-size:13px;word-break:break-all;}
  #right{width:420px;display:flex;flex-direction:column;gap:8px;}
  .panel{background:#00000022;padding:8px;border-radius:8px;overflow:auto;}
  footer{padding:8px;text-align:center;opacity:0.9;background:rgba(0,0,0,0.18);}
  button{padding:6px 10px;border-radius:6px;border:none;cursor:pointer;background:#fff;color:#333;font-weight:600;}
  input[type="text"]{padding:8px;border-radius:6px;border:0;width:360px;}
</style>
</head>
<body>
<header>
  <div><strong>Live Capture</strong></div>
  <div class="counts">
    <div class="box">Video: <span id="c-video">0</span></div>
    <div class="box">Image: <span id="c-image">0</span></div>
    <div class="box">Audio: <span id="c-audio">0</span></div>
    <div class="box">Other: <span id="c-other">0</span></div>
  </div>

  <div id="controls">
    <input id="urlInput" type="text" placeholder="Enter URL to load (https://...)" />
    <button onclick="startSession()">Open</button>
    <button onclick="sendControl({type:'snapshot'})">Snapshot (Puppeteer)</button>
  </div>
</header>

<main>
  <div id="left">
    <div id="iframeWrap"><iframe id="siteFrame" src="about:blank" sandbox></iframe></div>
    <div id="cards"></div>
  </div>

  <div id="right">
    <div class="panel">
      <h4>Actions (will forward to Puppeteer)</h4>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button onclick="sendControl({type:'click', x:100,y:100})">Click x100,y100</button>
        <button onclick="sendControl({type:'scroll', top:100})">Scroll 100px</button>
        <button onclick="sendControl({type:'reload'})">Reload Puppeteer</button>
        <button onclick="sendControl({type:'goto'})">Goto URL (Puppeteer)</button>
      </div>
      <p style="font-size:13px;color:#ddd">Tip: Use coordinate clicks for cross-origin pages (Puppeteer will perform same physical click on its page).</p>
    </div>

    <div class="panel">
      <h4>Captured Events</h4>
      <div id="events" style="max-height:40vh;overflow:auto"></div>
    </div>
  </div>
</main>

<footer id="footer">Status: idle</footer>

<script>
let evtSource = null;
let ws = null;
let counts = {video:0,image:0,audio:0,other:0};

function appendEvent(text){
  const el = document.createElement('div'); el.className='card'; el.textContent = text;
  document.getElementById('events').prepend(el);
}

function appendCaptured(data){
  const c = document.getElementById('cards');
  const el = document.createElement('div'); el.className='card';
  const pretty = JSON.stringify(data, null, 2);
  el.innerHTML = '<strong>'+data.type+'</strong> - ' + data.url + '<br/><small>'+ (data.source||'') +'</small>';
  c.prepend(el);
}

function updateCounts(type){
  counts[type] = (counts[type]||0) + 1;
  document.getElementById('c-'+type).textContent = counts[type];
}

function startSSE(url){
  if(evtSource){ try{ evtSource.close(); }catch{} }
  const u = '/events?url=' + encodeURIComponent(url);
  evtSource = new EventSource(u);
  evtSource.onopen = () => {
    document.getElementById('footer').textContent = 'SSE connected';
    appendEvent('SSE connected -> ' + u);
  };
  evtSource.onmessage = (e) => {
    try{
      const d = JSON.parse(e.data);
      appendCaptured(d);
      updateCounts(d.type || 'other');
      document.getElementById('footer').textContent = 'Last: ' + (d.url || d.type);
    }catch(err){ console.error(err); }
  };
  evtSource.onerror = (e) => {
    appendEvent('SSE error or closed');
    document.getElementById('footer').textContent = 'SSE disconnected';
  };
}

function startWS(){
  if(ws && ws.readyState===1) return;
  ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://') + location.host + '/control');
  ws.onopen = ()=> appendEvent('WS connected');
  ws.onmessage = (m)=> appendEvent('[WS recv] '+ m.data);
  ws.onclose = ()=> appendEvent('WS closed');
}

function sendControl(msg){
  startWS();
  if(!ws || ws.readyState!==1){ appendEvent('WS not ready'); return; }
  ws.send(JSON.stringify(msg));
  appendEvent('[WS send] ' + JSON.stringify(msg));
}

// Start a session: loads iframe AND starts SSE+Puppeteer capture
function startSession(){
  const url = document.getElementById('urlInput').value.trim();
  if(!url) return alert('Enter a URL');
  // load user-visible iframe (note: cross-origin pages cannot be inspected by client)
  const iframe = document.getElementById('siteFrame');
  iframe.src = url;
  document.getElementById('footer').textContent = 'Loaded iframe: ' + url;

  // start SSE server capture (Puppeteer side)
  startSSE(url);

  // open websocket to send interactive controls to puppeteer
  startWS();
}
</script>
</body>
</html>`);
});

// SSE endpoint — Puppeteer -> client
app.get("/events", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();
  sseClients.add(res);

  // when client disconnects
  req.on("close", () => {
    sseClients.delete(res);
  });

  const target = req.query.url;
  if (!target) {
    res.write(`data: ${JSON.stringify({type:'other', url:'No URL provided'})}\n\n`);
    return;
  }

  // Launch Puppeteer page and capture network
  const browser = await getBrowser();
  const page = await (await browser).newPage().catch(()=>null);
  const seen = new Set();

  function push(obj){
    if(!obj || !obj.url) return;
    const url = cleanURL(obj.url);
    if(seen.has(url)) return; seen.add(url);
    let type = 'other';
    const u = url.toLowerCase();
    if(u.match(/\\.(mp4|webm|mkv|m3u8)/)) type='video';
    else if(u.match(/\\.(mp3|aac|ogg|opus|wav|m4a|flac)/)) type='audio';
    else if(u.match(/\\.(jpg|jpeg|png|gif|webp|bmp)/)) type='image';
    const payload = { type, url, source: obj.source || 'network' };
    // send to SSE clients
    sendSSE(payload);
  }

  // logs from page console if custom injected script logs with CAPTURE_MEDIA::
  page.on('console', msg => {
    try{
      const text = msg.text();
      if(text && text.startsWith('CAPTURE_MEDIA::')){
        const p = JSON.parse(text.replace(/^CAPTURE_MEDIA::/,''));
        // p could be {type:'url', url:...}
        if(p && p.url) push({url:p.url, source:p.note||'console'});
      } else {
        // optional: forward console logs
        // sendSSE({type:'log', url:text});
      }
    }catch(e){}
  });

  page.on('response', async response => {
    try{
      const rurl = response.url();
      const headers = response.headers();
      const ct = headers['content-type'] || '';
      if(ct.match(/video|audio|image/i) || MEDIA_EXT_RE.test(rurl) || rurl.includes('cdn')){
        push({url:rurl, contentType:ct, source:'response'});
      } else {
        // try to inspect xhr json bodies for embedded media links
        const req = response.request();
        if(req && req.resourceType && req.resourceType() === 'xhr' && ct.includes('application/json')){
          try{
            const txt = await response.text();
            const matches = txt.match(/https?:\\/\\/[\\w\\-./?=&%]+\\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|jpeg|png|gif|webp)/gi);
            if(matches) matches.forEach(u=>push({url:u, source:'xhr-json'}));
          }catch(e){}
        }
      }
    }catch(e){}
  });

  page.on('requestfinished', reqf=>{
    try{
      const rurl = reqf.url();
      if(MEDIA_EXT_RE.test(rurl) || rurl.includes('cdn')) push({url:rurl, source:'requestfinished'});
    }catch(e){}
  });

  // Handle control websocket messages by mapping to actions on Puppeteer page
  const clientsForPage = new Set();
  function applyControlMessage(wsMsg){
    try{
      const msg = JSON.parse(wsMsg);
      (async ()=>{
        if(!page) return;
        if(msg.type === 'click'){
          // click by coordinates
          const x = msg.x || 10, y = msg.y || 10;
          await page.mouse.click(x, y);
          sendSSE({type:'other', url:`clicked at ${x},${y}`});
        } else if(msg.type === 'scroll'){
          const top = msg.top || 0;
          await page.evaluate(t=>window.scrollTo({top:t,left:0,behavior:'smooth'}), top);
          sendSSE({type:'other', url:`scrolled to ${top}`});
        } else if(msg.type === 'goto'){
          const u = msg.url || target;
          await page.goto(u, {waitUntil:'networkidle2', timeout:60000}).catch(()=>{});
          sendSSE({type:'other', url:`puppeteer goto ${u}`});
        } else if(msg.type === 'reload'){
          await page.reload({waitUntil:'networkidle2'}).catch(()=>{});
          sendSSE({type:'other', url:'puppeteer reloaded'});
        } else if(msg.type === 'snapshot'){
          try{
            const img = await page.screenshot({encoding:'base64', fullPage:false});
            sendSSE({type:'snapshot', url:'data:image/png;base64,'+img});
          }catch(e){}
        } else if(msg.type === 'type'){
          await page.keyboard.type(msg.text || '');
          sendSSE({type:'other', url:'typed: '+(msg.text||'')});
        }
      })();
    }catch(e){}
  }

  // Accept control messages from any connected WS client (wss)
  const wsHandler = (ws, req) => {
    // this server-level handler will forward messages to applyControlMessage
    ws.on('message', (m) => {
      applyControlMessage(m.toString());
    });
  };
  // Attach a temporary one-time listener for ws connections
  const onConn = (socket) => wsHandler(socket);
  wss.on('connection', onConn);

  // Navigate puppeteer page
  await page.goto(target, {waitUntil:'networkidle2', timeout:60000}).catch(()=>{});
  // small wait to capture initial network traffic
  await new Promise(r=>setTimeout(r, 4000));

  // Optionally inject a small script into the page to capture fetch/xhr/media creation (best-effort)
  try{
    await page.evaluateOnNewDocument(()=> {
      (function(){
        const send = (obj) => console.log('CAPTURE_MEDIA::'+JSON.stringify(obj));
        try {
          const origFetch = window.fetch.bind(window);
          window.fetch = function(...args){
            const p = origFetch(...args);
            p.then(async resp=>{
              try{
                const u = resp.url || (args[0]||'');
                const ct = resp.headers && resp.headers.get ? resp.headers.get('content-type') : '';
                if(ct && (ct.includes('video')||ct.includes('audio')||ct.includes('image'))) send({type:'url', url:u, note:'fetch'});
                // small blob => dataurl
                try{
                  const c = resp.clone();
                  if(c && typeof c.blob === 'function'){
                    const b = await c.blob();
                    if(b && b.size && b.size < 200*1024){
                      const r = new FileReader();
                      r.onload = ()=> send({type:'dataurl', data:r.result, note:'fetch-blob'});
                      r.readAsDataURL(b);
                    }
                  }
                }catch(e){}
              }catch(e){}
            }).catch(()=>{});
            return p;
          };
        }catch(e){}
        try{
          const origXHROpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url){
            this._capUrl = url;
            return origXHROpen.apply(this, arguments);
          };
          const origXHRSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function(){
            this.addEventListener && this.addEventListener('load', function(){
              try{
                const ct = this.getResponseHeader && this.getResponseHeader('content-type')||'';
                if(ct.includes('video')||ct.includes('audio')||ct.includes('image') || (this._capUrl||'').match(/\\.(mp4|webm|mp3|jpg|png)/i)){
                  send({type:'url', url:this._capUrl, note:'xhr'});
                }
              }catch(e){}
            });
            return origXHRSend.apply(this, arguments);
          };
        }catch(e){}
        // DOM scan
        try{
          const collect = ()=>{
            const out=[];
            document.querySelectorAll('video,audio,img,source').forEach(el=>{
              try{
                if(el.src) out.push(el.src);
                if(el.currentSrc) out.push(el.currentSrc);
                if(el.tagName === 'SOURCE' && el.src) out.push(el.src);
              }catch(e){}
            });
            out.forEach(u=>u && send({type:'url', url:u, note:'dom'}));
          };
          collect();
          new MutationObserver(collect).observe(document,{childList:true,subtree:true});
        }catch(e){}
      })();
    });
  }catch(e){ /* injection might fail for some pages */ }

  // keep SSE open for some time (or until client closes)
  // we'll wait until client disconnects or 40 seconds
  const maxMs = 120000; // 2 minutes default
  let finished = false;
  req.on('close', () => { finished = true; });

  const start = Date.now();
  while(!finished && (Date.now()-start) < maxMs){
    await new Promise(r=>setTimeout(r, 500)); // keep loop alive so response handlers can push
  }

  // cleanup
  try { await page.close(); } catch(e){}
  // remove ws listener we added earlier
  wss.removeListener('connection', onConn);
  res.end();
});

// WebSocket server simple echo (we already used wss in events)
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    // Messages will be consumed in applyControlMessage via the onConn handler in /events,
    // but keep an echo so dashboard shows response
    try{ ws.send(JSON.stringify({echo: msg.toString()})); }catch(e){}
  });
});

server.listen(PORT, ()=> console.log('Server running on http://localhost:' + PORT));
