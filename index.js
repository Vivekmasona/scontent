import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

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

const SESSIONS = {};
const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mkv|mp3|aac|ogg|opus|wav|flac|m4a|jpg|jpeg|png|gif|bmp|webp)(\?|$)/i;
const PRIORITY_DOMAINS = ["youtube.com","googlevideo","youtu.be","cdninstagram","fbcdn.net","facebook.com","twitter.com","twimg.com","soundcloud.com","vimeo.com","play.google.com"];

// Start session endpoint
app.get("/token", async (req, res) => {
  const { url } = req.query;
  if(!url) return res.status(400).send("Provide ?url=...");

  const sessionId = uuidv4();
  SESSIONS[sessionId] = { clients: new Set(), results: [], timer: null, page: null };
  const host = req.protocol + "://" + req.get("host");
  const viewerUrl = `/viewer?session=${sessionId}&target=${encodeURIComponent(url)}`;

  // Background Puppeteer crawl
  (async () => {
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      SESSIONS[sessionId].page = page;

      await page.evaluateOnNewDocument(() => {
        (function(){
          const send = (o) => console.log("CAPTURE::"+JSON.stringify(o));

          // patch fetch
          try {
            const of = window.fetch.bind(window);
            window.fetch = (...a)=>{
              const p = of(...a);
              p.then(r=>{
                try{
                  const ct = r.headers.get && r.headers.get("content-type") || "";
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
            const oopen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(m,u){ this._cap_u=u; return oopen.apply(this,arguments); };
            const osend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function(){
              this.addEventListener && this.addEventListener("load",function(){
                try{
                  const ct = this.getResponseHeader && this.getResponseHeader("content-type") || "";
                  const u = this._cap_u || "";
                  if(ct.includes("video")||ct.includes("audio")||ct.includes("image")||u.match(/\.(mp4|webm|mp3|jpg|png)/i)){
                    send({url:u,ct,note:"xhr"});
                  }
                }catch(e){}
              });
              return osend.apply(this,arguments);
            };
          }catch(e){}

          // DOM scan
          const collectDom = ()=>{
            const out=[];
            document.querySelectorAll("video,audio,img,source").forEach(el=>{
              const srcs=[];
              if(el.src) srcs.push(el.src);
              if(el.currentSrc) srcs.push(el.currentSrc);
              if(el.getAttribute){ const s=el.getAttribute("src"); if(s) srcs.push(s);}
              if(el.querySelectorAll) el.querySelectorAll("source").forEach(s=>s.src&&srcs.push(s.src));
              srcs.forEach(u=>out.push(u));
            });
            if(out.length) send({type:"dom",items:Array.from(new Set(out))});
          };
          collectDom();
          new MutationObserver(collectDom).observe(document,{childList:true,subtree:true});
        })();
      });

      page.on("console", msg => {
        try{
          const txt = msg.text();
          if(!txt.startsWith("CAPTURE::")) return;
          const payload = JSON.parse(txt.replace(/^CAPTURE::/,""));
          handleCaptured(sessionId,payload);
        }catch(e){}
      });

      page.on("response", async response => {
        try{
          const rurl = response.url().replace(/&bytestart=\d+&byteend=\d+/gi,"");
          const ct = response.headers()["content-type"] || "";
          if(ct.includes("video")||ct.includes("audio")||ct.includes("image")||/m3u8|mpegurl/i.test(ct)){
            handleCaptured(sessionId,{url:rurl,ct,note:"network-response"});
          } else if(MEDIA_EXT_RE.test(rurl)){
            handleCaptured(sessionId,{url:rurl,note:"network-ext"});
          }
        }catch(e){}
      });

      await page.goto(url,{waitUntil:"networkidle2",timeout:60000}).catch(()=>{});
    } catch(e){ console.error(e); }
  })();

  res.json({ session: sessionId, host, viewer: host + viewerUrl, results: [] });
});

// Proxy endpoint to serve captured media via host
app.get("/proxy", async (req,res)=>{
  const { url }=req.query;
  if(!url) return res.status(400).send("Provide ?url=...");
  try{
    const r = await fetch(url);
    const ct = r.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type",ct);
    const buffer = await r.arrayBuffer();
    res.send(Buffer.from(buffer));
  }catch(e){ res.status(500).send("Failed"); }
});

// Viewer page
app.get("/viewer", (req,res)=>{
  const { session, target } = req.query;
  if(!session || !SESSIONS[session] || !target) return res.status(400).send("Missing session or target");
  const host = req.protocol + "://" + req.get("host");

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Live Extractor</title>
<style>
body{margin:0;font-family:Arial,sans-serif;background:#111;color:#fff;height:100vh;display:flex;flex-direction:column}
#iframe-container{height:60%} iframe{width:100%;height:100%;border:0}
#footer{height:40%;background:#222;display:flex;flex-direction:column}
#tab-scroll{flex:1;overflow-x:auto;display:flex;gap:8px;padding:6px;align-items:center}
.media-item{min-width:220px;background:#333;border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:4px;color:#fff}
.media-item img, .media-item video, .media-item audio{max-width:200px;max-height:120px;border-radius:4px}
.buttons{display:flex;gap:4px;flex-wrap:wrap}
.buttons button,.buttons a{padding:4px 6px;border:none;border-radius:4px;cursor:pointer;background:#555;color:#fff}
</style>
</head>
<body>
<div id="iframe-container"><iframe src="${target}" id="frame"></iframe></div>
<div id="footer">
  <div id="tab-scroll"></div>
</div>
<script>
const session="${session}";
const tabScroll=document.getElementById("tab-scroll");
const clients={};

const evt=new EventSource("/stream?session="+encodeURIComponent(session));
evt.onmessage=e=>{
  try{
    const payload=JSON.parse(e.data);
    if(payload.type==="found" && payload.item) addItem(payload.item);
  }catch(e){}
};
function addItem(it){
  const url=it.url;
  if(!url||clients[url]) return;
  const div=document.createElement("div"); div.className="media-item";
  let mediaHtml="";
  if(it.type==="image") mediaHtml=\`<img src="\${url}">\`;
  else if(it.type==="video") mediaHtml=\`<video src="\${url}" controls></video>\`;
  else if(it.type==="audio") mediaHtml=\`<audio src="\${url}" controls></audio>\`;
  else mediaHtml=\`<a href="\${url}" target="_blank">Link</a>\`;
  div.innerHTML=mediaHtml;
  const btns=document.createElement("div"); btns.className="buttons";
  const dl=document.createElement("a"); dl.href=url; dl.download=""; dl.textContent="Download";
  const cp=document.createElement("button"); cp.textContent="Copy"; cp.onclick=()=>{navigator.clipboard.writeText(url); cp.textContent="Copied"; setTimeout(()=>cp.textContent="Copy",1200);};
  btns.appendChild(dl); btns.appendChild(cp);
  div.appendChild(btns);
  tabScroll.appendChild(div);
  clients[url]=true;
}
</script>
</body>
</html>`;

  res.send(html);
});

// SSE stream
app.get("/stream", (req,res)=>{
  const { session }=req.query;
  if(!session || !SESSIONS[session]) return res.status(404).send("Invalid session");
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders?.();

  SESSIONS[session].results.forEach(r=>{
    try{ res.write(`data: ${JSON.stringify({type:"found",item:r})}\n\n`); }catch(e){}
  });

  SESSIONS[session].clients.add(res);
  const keep=setInterval(()=>res.write(": ping\n\n"),25000);
  req.on("close",()=>{ clearInterval(keep); if(SESSIONS[session]) SESSIONS[session].clients.delete(res); });
});

// helpers
function handleCaptured(sessionId,item){
  if(!SESSIONS[sessionId]) return;
  if(item.type==="dom" && Array.isArray(item.items)){
    item.items.forEach(u=>push(sessionId,{url:u,source:"dom"}));
    return;
  }
  if(item.url) push(sessionId,{url:item.url,contentType:item.ct||item.contentType,source:item.note||item.source});
}
function push(sessionId,item){
  if(!SESSIONS[sessionId]) return;
  const url=item.url;
  if(!url) return;
  if(SESSIONS[sessionId].results.find(r=>r.url===url)) return;
  let type = item.type || null;
  if(!type){
    if((item.contentType||"").startsWith("image")) type="image";
    else if((item.contentType||"").startsWith("video")) type="video";
    else if((item.contentType||"").startsWith("audio")) type="audio";
    else if(url.match(/\.(mp4|webm|m3u8)/i)) type="video";
    else if(url.match(/\.(mp3|aac|wav|m4a|flac|ogg|opus)/i)) type="audio";
    else if(url.match(/\.(jpg|jpeg|png|gif|webp|bmp)/i)) type="image";
    else type = "media";
  }
  SESSIONS[sessionId].results.push({url,type,source:item.source||item.note||null,contentType:item.contentType||item.ct||null,title:null});
}

app.listen(PORT,()=>console.log("Server running on",PORT));
