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

app.get("/start-session", async (req, res) => {
  const { url } = req.query;
  if(!url) return res.status(400).send("Provide ?url=...");

  const sessionId = uuidv4();
  SESSIONS[sessionId] = { clients: new Set(), results: [], timer: null, page: null };
  const host = req.protocol + "://" + req.get("host");
  const viewerUrl = `/viewer?session=${sessionId}&target=${encodeURIComponent(url)}`;

  (async () => {
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      SESSIONS[sessionId].page = page;

      await page.evaluateOnNewDocument(() => {
        (function(){
          const send = (o) => console.log("CAPTURE::"+JSON.stringify(o));
          const patchFetch = () => {
            try {
              const of = window.fetch.bind(window);
              window.fetch = (...a)=>{
                const p = of(...a);
                p.then(r=>{
                  try{
                    const ct = r.headers.get&&r.headers.get("content-type")||"";
                    if(ct.includes("video")||ct.includes("audio")||ct.includes("image")||/m3u8|mpegurl/i.test(ct)||(r.url&&r.url.match(/\.(mp4|webm|m3u8|mp3|jpg|png)/i))){
                      send({url:r.url,ct,note:"fetch"});
                    }
                  }catch(e){}
                }).catch(()=>{});
                return p;
              };
            }catch(e){}
          };
          patchFetch();

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

  const getSortedResults = ()=>{
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

  res.json({ session: sessionId, host, viewer: host + viewerUrl, results: getSortedResults() });
});

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
    else type="media";
  }
  SESSIONS[sessionId].results.push({url,type,source:item.source||item.note||null,contentType:item.contentType||item.ct||null,title:null});
}

app.listen(PORT,()=>console.log("Server running on",PORT));
