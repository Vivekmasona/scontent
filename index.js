import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch"; // npm install node-fetch@2

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

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

// In-memory session storage
const SESSIONS = {}; // sessionId -> { clients: Set(res), results: [], timer, page }

const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mkv|mp3|aac|ogg|opus|wav|flac|m4a|jpg|jpeg|png|gif|bmp|webp)(\?|$)/i;
const PRIORITY_DOMAINS = [
  "youtube.com", "googlevideo", "youtu.be",
  "cdninstagram", "fbcdn.net", "facebook.com",
  "twitter.com", "twimg.com", "soundcloud.com",
  "vimeo.com", "play.google.com"
];

// ---------------- START SESSION ----------------
app.get("/token", async (req, res) => {
  const { url, timeout } = req.query;
  if (!url) return res.status(400).send("Provide ?url=...");
  const sessionId = uuidv4();
  SESSIONS[sessionId] = { clients: new Set(), results: [], timer: null, page: null };

  const host = req.protocol + "://" + req.get("host"); // host base URL
  const viewerUrl = `/viewer?session=${sessionId}&target=${encodeURIComponent(url)}`;

  // cleanup timer
  const killTimeout = Number(timeout) || 90000;
  const resetKillTimer = () => {
    if (SESSIONS[sessionId].timer) clearTimeout(SESSIONS[sessionId].timer);
    SESSIONS[sessionId].timer = setTimeout(async () => {
      try { if (SESSIONS[sessionId].page) await SESSIONS[sessionId].page.close(); } catch(e){}
      delete SESSIONS[sessionId];
    }, killTimeout);
  };
  resetKillTimer();

  // Puppeteer background crawl
  (async () => {
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      SESSIONS[sessionId].page = page;

      // Inject capture script
      await page.evaluateOnNewDocument(() => {
        (function(){
          const send = (o)=>console.log("CAPTURE::"+JSON.stringify(o));
          // patch fetch
          try {
            const of=window.fetch.bind(window);
            window.fetch=(...a)=>{
              const p=of(...a);
              p.then(r=>{
                try{
                  const ct=r.headers.get&&r.headers.get("content-type")||"";
                  if(ct.includes("video")||ct.includes("audio")||ct.includes("image")||/m3u8|mpegurl/i.test(ct)||(r.url&&r.url.match(/\.(mp4|webm|m3u8|mp3|jpg|png)/i))){
                    send({url:r.url,ct,note:"fetch"});
                  }
                }catch(e){}
              }).catch(()=>{});
              return p;
            };
          }catch(e){}
          // patch XHR
          try {
            const oopen=XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open=function(m,u){ this._cap_u=u; return oopen.apply(this,arguments); };
            const osend=XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send=function(){
              this.addEventListener&&this.addEventListener("load",function(){
                try{
                  const ct=this.getResponseHeader&&this.getResponseHeader("content-type")||"";
                  const u=this._cap_u||"";
                  if(ct.includes("video")||ct.includes("audio")||ct.includes("image")||u.match(/\.(mp4|webm|mp3|jpg|png)/i)){
                    send({url:u,ct,note:"xhr"});
                  }
                  if(ct.includes("application/json")&&this.responseText){
                    const preview=this.responseText.slice(0,8000);
                    send({type:"json-preview",url:u,preview});
                  }
                }catch(e){}
              });
              return osend.apply(this,arguments);
            };
          }catch(e){}
          // DOM scan
          try {
            const collect=()=>{
              const out=[];
              document.querySelectorAll("video, audio, img, source").forEach(el=>{
                const srcs=[];
                if(el.src) srcs.push(el.src);
                if(el.currentSrc) srcs.push(el.currentSrc);
                if(el.getAttribute){
                  const s=el.getAttribute("src");
                  if(s) srcs.push(s);
                }
                if(el.querySelectorAll) el.querySelectorAll("source").forEach(s=>s.src&&srcs.push(s.src));
                srcs.forEach(u=>out.push(u));
              });
              if(out.length) send({type:"dom",items:Array.from(new Set(out))});
            };
            collect();
            new MutationObserver(collect).observe(document,{childList:true,subtree:true});
          }catch(e){}
        })();
      });

      // Listen to console messages
      page.on("console", msg => {
        try{
          const txt=msg.text();
          if(!txt||!txt.startsWith("CAPTURE::")) return;
          const payload=JSON.parse(txt.replace(/^CAPTURE::/,""));
          handleCaptured(sessionId,payload);
        }catch(e){}
      });

      // Network-level capture
      page.on("response", async response => {
        try{
          let rurl = response.url().replace(/&bytestart=\d+&byteend=\d+/gi,"");
          const ct = response.headers()["content-type"] || "";
          if(ct.includes("video")||ct.includes("audio")||ct.includes("image")||/m3u8|mpegurl/i.test(ct)){
            handleCaptured(sessionId,{url:rurl,ct,note:"network-response"});
          } else if(MEDIA_EXT_RE.test(rurl)){
            handleCaptured(sessionId,{url:rurl,note:"network-ext"});
          } else {
            const req = response.request();
            if(req && req.resourceType && req.resourceType()==="xhr" && ct.includes("application/json")){
              try{
                const text = await response.text();
                const matches = (text||"").match(/https?:\/\/[^\s"']+\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|jpeg|png|gif|webp)/gi);
                if(matches) matches.forEach(u=>handleCaptured(sessionId,{url:u,note:"xhr-json"}));
              }catch(e){}
            }
          }
        }catch(e){}
      });

      page.on("requestfinished", req=>{
        try{
          const rurl=req.url().replace(/&bytestart=\d+&byteend=\d+/gi,"");
          if(MEDIA_EXT_RE.test(rurl)) handleCaptured(sessionId,{url:rurl,note:"requestfinished"});
        }catch(e){}
      });

      await page.goto(url,{waitUntil:"networkidle2",timeout:60000}).catch(()=>{});
      // final DOM scan
      const dom = await page.evaluate(()=>{
        const out=[];
        document.querySelectorAll("video, audio, img, source").forEach(el=>{
          if(el.currentSrc) out.push(el.currentSrc);
          if(el.src) out.push(el.src);
          if(el.getAttribute){ const s=el.getAttribute("src"); if(s) out.push(s);}
          if(el.querySelectorAll) el.querySelectorAll("source").forEach(s=>s.src&&out.push(s.src));
        });
        return Array.from(new Set(out));
      });
      dom.forEach(u=>handleCaptured(sessionId,{url:u,note:"dom-final"}));
      await new Promise(r=>setTimeout(r,1800));
    } catch(err){
      console.error("Session crawl error:",err&&err.stack||err);
    }
  })();

  // prepare initial JSON response
  const getSortedResults = () => {
    if(!SESSIONS[sessionId]) return [];
    const all = [...SESSIONS[sessionId].results];
    const priority = [];
    const normal = [];
    all.forEach(r=>{
      if((r.type==="video"||r.type==="audio") && PRIORITY_DOMAINS.some(d=>r.url.includes(d))){
        priority.push({...r,url:host+"/proxy?url="+encodeURIComponent(r.url)});
      } else normal.push({...r,url:host+"/proxy?url="+encodeURIComponent(r.url)});
    });
    return [...priority,...normal];
  };

  res.json({
    session: sessionId,
    host,
    viewer: host + viewerUrl,
    results: getSortedResults()
  });
});

// ---------------- STREAM SSE ----------------
app.get("/stream", (req,res)=>{
  const { session } = req.query;
  if(!session||!SESSIONS[session]) return res.status(404).send("Invalid session");
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders?.();

  const sendEvent = (ev)=>{ try{ res.write(`data: ${JSON.stringify(ev)}\n\n`); }catch(e){} };
  SESSIONS[session].results.forEach(r=>sendEvent({type:"found",item:r}));
  SESSIONS[session].clients.add(res);
  const keep = setInterval(()=>res.write(": ping\n\n"),25000);
  req.on("close",()=>{
    clearInterval(keep);
    if(SESSIONS[session]) SESSIONS[session].clients.delete(res);
  });
});

// ---------------- VIEWER ----------------
app.get("/viewer",(req,res)=>{
  const { session,target }=req.query;
  if(!session||!SESSIONS[session]||!target) return res.status(400).send("Missing session or target");
  const html=`<!doctype html>
  <html>
  <head><meta charset="utf-8"><title>Live Extractor - ${session}</title>
  <style>
  body{margin:0;font-family:Arial;height:100vh;display:flex;flex-direction:column;}
  #top{background:#111;color:#fff;padding:8px;display:flex;gap:8px;align-items:center;}
  #list{display:flex;gap:8px;overflow:auto;padding:6px;}
  .item{background:#fff2;color:#000;padding:8px;border-radius:6px;min-width:220px;display:flex;flex-direction:column;gap:6px;}
  .item .url{font-size:12px;word-break:break-all;}
  .item .meta{font-size:11px;color:#eee;}
  iframe{flex:1;border:0;width:100%;height:calc(100vh - 84px);}
  .controls{margin-left:auto;display:flex;gap:6px;}
  button{padding:6px 8px;border-radius:6px;border:0;cursor:pointer;}
  </style></head>
  <body>
  <div id="top">
    <strong>Live Captured URLs</strong>
    <div class="controls">
      <button id="clear">Clear List</button>
      <button id="downloadAll">Copy URLs</button>
    </div>
  </div>
  <div id="list"></div>
  <iframe id="frame" src="${target}"></iframe>
  <script>
  const session="${session}";
  const listEl=document.getElementById("list");
  const clients={};
  const ev=new EventSource("/stream?session="+encodeURIComponent(session));
  ev.onmessage=(m)=>{try{const payload=JSON.parse(m.data);if(payload.type==="found"&&payload.item)addItem(payload.item);else if(payload.url)addItem(payload);}catch(e){}};
  ev.onerror=(e)=>{console.log("SSE error",e);};
  function addItem(it){
    const url=it.url||it.data||it;
    if(!url) return;
    if(clients[url]){clients[url].el.style.border="2px solid #ff0"; return;}
    const div=document.createElement("div"); div.className="item";
    const title=document.createElement("div"); title.className="meta"; title.textContent=(it.type||it.contentType||it.source||"media")+" — "+(it.note||"");
    const u=document.createElement("div"); u.className="url"; u.textContent=url;
    const actions=document.createElement("div"); actions.style.display="flex"; actions.style.gap="6px";
    const a=document.createElement("a"); a.href=url; a.target="_blank"; a.textContent="Open";
    const dl=document.createElement("a"); dl.href=url; dl.download=""; dl.textContent="Download";
    const cp=document.createElement("button"); cp.textContent="Copy"; cp.onclick=()=>{navigator.clipboard.writeText(url); cp.textContent="Copied"; setTimeout(()=>cp.textContent="Copy",1200);};
    actions.appendChild(a); actions.appendChild(dl); actions.appendChild(cp);
    div.appendChild(title); div.appendChild(u); div.appendChild(actions);
    listEl.prepend(div);
    clients[url]={el:div,item:it};
  }
  document.getElementById("clear").onclick=()=>{listEl.innerHTML="";for(let k in clients) delete clients[k];};
  document.getElementById("downloadAll").onclick=async()=>{const keys=Object.keys(clients);if(!keys.length) return alert("No URLs"); await navigator.clipboard.writeText(keys.join("\\n")); alert("Copied "+keys.length+" URLs to clipboard");};
  </script></body></html>`;
  res.send(html);
});

// ---------------- PROXY ----------------
app.get("/proxy", async (req,res)=>{
  const { url }=req.query;
  if(!url) return res.status(400).send("Provide ?url=...");
  try{
    const r = await fetch(url);
    const contentType = r.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type",contentType);
    const buffer = await r.arrayBuffer();
    res.send(Buffer.from(buffer));
  }catch(e){ res.status(500).send("Failed to proxy"); }
});

// ---------------- CAPTURE HANDLER ----------------
function handleCaptured(sessionId,payload){
  try{
    if(!sessionId||!SESSIONS[sessionId]) return;
    if(payload.type==="dom"&&Array.isArray(payload.items)){
      payload.items.forEach(u=>push(sessionId,{url:u,source:"dom"}));
      return;
    }
    if(payload.type==="json-preview"&&payload.preview){
      const matches = (payload.preview||"").match(/https?:\/\/[^\s"']+\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|jpeg|png|gif|webp)/gi);
      if(matches) matches.forEach(u=>push(sessionId,{url:u,source:"json-preview"}));
      return;
    }
    if(payload.url) push(sessionId,{url:payload.url,contentType:payload.ct||payload.contentType,source:payload.note||payload.source});
  }catch(e){}
}
function push(sessionId,item){
  try{
    if(!SESSIONS[sessionId]) return;
    const url=item.url;
    if(!url) return;
    const exists = SESSIONS[sessionId].results.find(r=>r.url===url);
    if(exists) return;

    let type = item.type || null;
    if(!type){
      if((item.contentType||"").startsWith("image")) type="image";
      else if((item.contentType||"").startsWith("video")) type="video";
      else if((item.contentType||"").startsWith("audio")) type="audio";
      else if(url.match(/\.(mp4|webm|mkv|m3u8)/i)) type="video";
      else if(url.match(/\.(mp3|aac|wav|m4a|flac|ogg|opus)/i)) type="audio";
      else if(url.match(/\.(jpg|jpeg|png|gif|webp|bmp)/i)) type="image";
      else type="media";
    }

    const entry={url,type,source:item.source||item.note||null,contentType:item.contentType||item.ct||null,title:null};
    SESSIONS[sessionId].results.push(entry);

    // priority sort
    SESSIONS[sessionId].results.sort((a,b)=>{
      const ap=PRIORITY_DOMAINS.some(d=>a.url.includes(d))?1:0;
      const bp=PRIORITY_DOMAINS.some(d=>b.url.includes(d))?1:0;
      return bp-ap;
    });

    // notify SSE clients
    SESSIONS[sessionId].clients.forEach(res=>{
      try{ res.write(`data: ${JSON.stringify({type:"found",item:entry})}\n\n`); }catch(e){}
    });
  }catch(e){}
}

// ---------------- START SERVER ----------------
app.listen(PORT,()=>console.log("Server running on",PORT));
