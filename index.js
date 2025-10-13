// server.js
import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { v4 as uuidv4 } from "uuid";

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

// In-memory sessions (simple)
const SESSIONS = {}; // sessionId -> { clients:Set, results:[], timer, page }

const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mkv|mp3|aac|ogg|opus|wav|flac|m4a|jpg|jpeg|png|gif|bmp|webp)(\?|$)/i;
const PRIORITY_DOMAINS = ["youtube.com","googlevideo","youtu.be","cdninstagram","fbcdn.net","instagram.com","cloudfront.net","akamai","vimeo.com","discordapp","storage.googleapis.com","s3.amazonaws.com","cdn.cloudflare"];

// Helper: domain classification
function hostnameOf(url) {
  try { return new URL(url).hostname || ""; } catch(e){ return ""; }
}

// Improved cleaner: keep essential params for trusted CDNs, otherwise safely strip common tracking params.
function cleanUrlPreserveForCDN(rawUrl) {
  try {
    if (!rawUrl) return rawUrl;
    // keep data: and blob: as-is
    if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return rawUrl;

    // normalize protocol-prefixed URLs
    let urlStr = rawUrl.trim().replace(/^"+|"+$/g, "");
    if (urlStr.startsWith("//")) urlStr = "https:" + urlStr;

    // Some pages pass weird relative src - ignore
    if (!/^https?:\/\//i.test(urlStr)) return urlStr;

    const urlObj = new URL(urlStr);

    const host = urlObj.hostname.toLowerCase();

    // Params to ALWAYS remove when safe
    const removeIfFound = ["bytestart","byteend","_= ", "_","utm_source","utm_medium","utm_campaign","utm_term","utm_content","ref","ref_src","_nc_cid","_nc_ohc","fbclid","gclid","_ga","_gl","_gid","_hsenc","_hsmi","_openstat","igshid"];

    // Trusted CDNs where we must be conservative (don't remove signature/expire etc)
    const trustedCDN = [
      "googlevideo.com","youtube.com","youtu.be",
      "cdninstagram.com","instagram.com","scontent.cdninstagram.com","fbcdn.net","cdn-fb","akamaihd.net",
      "cloudfront.net","akamaized.net","vimeo.com","video.vimeocdn.com","discordapp.com","storage.googleapis.com","amazonaws.com","s3.amazonaws.com"
    ];

    // If host is trusted CDN - only remove safe small keys that are known to be harmless
    if (trustedCDN.some(d => host.includes(d))) {
      // keep most params, but remove only bytestart/byteend and known tiny trackers
      removeIfFound.forEach(k => urlObj.searchParams.delete(k));
      // also remove empty params
      for (const [k,v] of Array.from(urlObj.searchParams.entries())) {
        if (!v || v === "undefined") urlObj.searchParams.delete(k);
      }
      // Some googlevideo links include 'range' or 'itag' - keep them.
      return urlObj.toString();
    }

    // For non-trusted hosts, remove heavy tracking params but preserve signature/expire if present
    // remove those in removeIfFound
    removeIfFound.forEach(k => urlObj.searchParams.delete(k));

    // preserve 'signature','sig','s','expire','expires','token','policy' if present
    const keep = new Set(["signature","sig","s","expire","expires","token","policy","key","auth"]);
    // But sometimes some long unknown params are safe to remove; if param value is obviously long tracking (like "fbclid" already removed) we trimmed above.

    // Remove blank keys
    for (const [k,v] of Array.from(urlObj.searchParams.entries())) {
      if (!v || v === "undefined") urlObj.searchParams.delete(k);
    }

    // Final cleanup: remove trailing ? or &
    let cleaned = urlObj.toString().replace(/[?&]+$/,"");
    return cleaned;
  } catch(e) {
    return rawUrl;
  }
}

// Try lightweight HEAD to validate content-type; if HEAD not allowed, try GET with range header for a few bytes.
async function checkPlayable(url) {
  try {
    // Only attempt for http(s)
    if (!/^https?:\/\//i.test(url)) return { ok: true, contentType: null };
    // Attempt HEAD
    let resp;
    try {
      resp = await fetch(url, { method: "HEAD", redirect: "follow", timeout: 8000 });
      if (!resp.ok) {
        // try range GET
        resp = await fetch(url, { method: "GET", headers: { Range: "bytes=0-32767" }, redirect: "follow", timeout: 10000 });
      }
    } catch (err) {
      // fallback to GET with range if HEAD fails
      try {
        resp = await fetch(url, { method: "GET", headers: { Range: "bytes=0-32767" }, redirect: "follow", timeout: 10000 });
      } catch (e) {
        return { ok: false, contentType: null };
      }
    }
    const ct = resp.headers.get("content-type") || "";
    const ok = resp.status >= 200 && resp.status < 400 && (ct.includes("video") || ct.includes("audio") || ct.includes("image") || MEDIA_EXT_RE.test(url));
    return { ok, contentType: ct || null };
  } catch (e) {
    return { ok: false, contentType: null };
  }
}

// push helper and SSE notification
function pushToSession(sessionId, item) {
  try {
    if (!SESSIONS[sessionId]) return;
    const raw = item.url;
    if (!raw) return;

    // clean carefully to avoid breaking signed links for instagram/googlevideo/fbcdn
    const cleaned = cleanUrlPreserveForCDN(raw);
    if (!cleaned) return;

    // dedupe by cleaned url
    if (SESSIONS[sessionId].results.find(r => r.url === cleaned)) return;

    // attempt playable check (best-effort, non-blocking)
    (async () => {
      const chk = await checkPlayable(cleaned).catch(()=>({ok:false,contentType:null}));
      const host = hostnameOf(cleaned);
      const isCdn = /cdn|googlevideo|fbcdn|akamai|cloudfront|akamaized|cdninstagram|vimeocdn|discordapp|storage/.test(host);
      const typeGuess = (item.contentType || "").startsWith("image") ? "image" :
                        (item.contentType || "").startsWith("video") ? "video" :
                        (item.contentType || "").startsWith("audio") ? "audio" :
                        (cleaned.match(/\.(mp4|webm|m3u8|mkv)/i) ? "video" :
                         cleaned.match(/\.(mp3|aac|wav|m4a|flac|ogg|opus)/i) ? "audio" :
                         cleaned.match(/\.(jpg|jpeg|png|gif|webp|bmp)/i) ? "image" : "media");
      const entry = {
        url: cleaned,
        original: raw,
        type: typeGuess,
        cdn: isCdn,
        source: item.source || item.note || null,
        contentType: item.contentType || item.ct || null,
        playable: chk.ok,
        checkedContentType: chk.contentType,
        title: null,
      };
      SESSIONS[sessionId].results.push(entry);
      // move CDN matches earlier
      SESSIONS[sessionId].results.sort((a,b)=>{
        const ap = PRIORITY_DOMAINS.some(d=>a.url.includes(d))?1:0;
        const bp = PRIORITY_DOMAINS.some(d=>b.url.includes(d))?1:0;
        return bp - ap;
      });
      // notify clients
      SESSIONS[sessionId].clients.forEach(res=>{
        try { res.write(`data: ${JSON.stringify({ type: "found", item: entry })}\n\n`); } catch(e){}
      });
    })();

  } catch(e){}
}

// Create session & start puppeteer crawl
app.get("/start-session", async (req, res) => {
  const { url, timeout } = req.query;
  if (!url) return res.status(400).json({ error: "Provide ?url=" });
  const sessionId = uuidv4();
  SESSIONS[sessionId] = { clients: new Set(), results: [], timer: null, page: null };

  const killTimeout = Number(timeout) || 90000;
  const resetKillTimer = () => {
    if (SESSIONS[sessionId].timer) clearTimeout(SESSIONS[sessionId].timer);
    SESSIONS[sessionId].timer = setTimeout(async () => {
      try { if (SESSIONS[sessionId].page) await SESSIONS[sessionId].page.close(); } catch(e){}
      delete SESSIONS[sessionId];
    }, killTimeout);
  };
  resetKillTimer();

  (async () => {
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      SESSIONS[sessionId].page = page;

      // inject capture hooks early
      await page.evaluateOnNewDocument(() => {
        (function(){
          const SEND = (o) => console.log("CAPTURE_SSE::" + JSON.stringify(o));
          // patch fetch
          try {
            const of = window.fetch.bind(window);
            window.fetch = (...a) => {
              const p = of(...a);
              p.then(r => {
                try {
                  const ct = r.headers && r.headers.get && r.headers.get("content-type") || "";
                  if (ct.includes("video")||ct.includes("audio")||ct.includes("image")||/m3u8|mpegurl/i.test(ct)||(r.url && r.url.match(/\\.(mp4|webm|m3u8|mp3|jpg|png)/i))) {
                    SEND({ url: r.url, ct, note: "fetch" });
                  }
                } catch(e){}
              }).catch(()=>{});
              return p;
            };
          } catch(e){}
          // patch XHR
          try {
            const oopen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(m,u){ this._cap_u = u; return oopen.apply(this, arguments); };
            const osend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function(){
              this.addEventListener && this.addEventListener("load", function(){
                try {
                  const ct = this.getResponseHeader && this.getResponseHeader("content-type") || "";
                  const u = this._cap_u || "";
                  if (ct.includes("video")||ct.includes("audio")||ct.includes("image")||u.match(/\\.(mp4|webm|mp3|jpg|png)/i)) {
                    SEND({ url: u, ct, note: "xhr" });
                  }
                  if (ct.includes("application/json") && this.responseText) {
                    SEND({ type: "json-preview", url:u, preview: this.responseText.slice(0, 8000) });
                  }
                } catch(e){}
              });
              return osend.apply(this, arguments);
            };
          } catch(e){}
          // observe DOM
          try {
            const collect = () => {
              const out=[];
              document.querySelectorAll("video, audio, img, source").forEach(el=>{
                if (el.currentSrc) out.push(el.currentSrc);
                if (el.src) out.push(el.src);
                if (el.getAttribute) {
                  const s = el.getAttribute("src"); if (s) out.push(s);
                }
                if (el.querySelectorAll) el.querySelectorAll("source").forEach(s=>s.src&&out.push(s.src));
              });
              if (out.length) SEND({ type: "dom", items: Array.from(new Set(out)) });
            };
            collect();
            new MutationObserver(collect).observe(document, { childList: true, subtree: true });
          } catch(e){}
          // patch URL.createObjectURL to try to surface blob fragments (best-effort)
          try {
            const orig = URL.createObjectURL.bind(URL);
            URL.createObjectURL = function (o) {
              try {
                if (o && o.size && o.size < 300 * 1024) {
                  const r = new FileReader();
                  r.onload = ()=> SEND({ type: "dataurl", data: r.result, note: "createObjectURL" });
                  r.readAsDataURL(o);
                }
              } catch(e){}
              return orig(o);
            };
          } catch(e){}
        })();
      });

      // capture page console messages with our prefix
      page.on("console", msg => {
        try {
          const txt = msg.text();
          if (!txt || !txt.startsWith("CAPTURE_SSE::")) return;
          const payload = JSON.parse(txt.replace(/^CAPTURE_SSE::/, ""));
          // forward to handler
          handlePayload(sessionId, payload);
        } catch(e){}
      });

      // network responses
      page.on("response", async response => {
        try {
          let rurl = response.url().replace(/&bytestart=\\d+&byteend=\\d+/gi, "");
          const headers = response.headers();
          const ct = headers["content-type"] || headers["Content-Type"] || "";
          if (ct && (ct.includes("video")||ct.includes("audio")||ct.includes("image")||/m3u8|mpegurl/i.test(ct))) {
            handlePayload(sessionId, { url: rurl, ct, note: "network-response" });
          } else if (MEDIA_EXT_RE.test(rurl)) {
            handlePayload(sessionId, { url: rurl, note: "network-ext" });
          } else {
            const req = response.request();
            if (req && req.resourceType && req.resourceType() === "xhr" && ct.includes("application/json")) {
              try {
                const text = await response.text();
                const matches = (text || "").match(/https?:\\/\\/[^\\s"']+\\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|jpeg|png|gif|webp)/gi);
                if (matches) matches.forEach(u => handlePayload(sessionId, { url: u, note: "xhr-json" }));
              } catch(e){}
            }
          }
        } catch(e){}
      });

      page.on("requestfinished", req=>{
        try {
          const rurl = req.url().replace(/&bytestart=\\d+&byteend=\\d+/gi, "");
          if (MEDIA_EXT_RE.test(rurl)) handlePayload(sessionId, { url: rurl, note: "requestfinished" });
        } catch(e){}
      });

      // visit the page
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }).catch(()=>{});
      // final DOM scan
      const dom = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("video, audio, img, source").forEach(el=>{
          if (el.currentSrc) out.push(el.currentSrc);
          if (el.src) out.push(el.src);
          if (el.getAttribute) { const s = el.getAttribute("src"); if (s) out.push(s); }
          if (el.querySelectorAll) el.querySelectorAll("source").forEach(s=>s.src&&out.push(s.src));
        });
        return Array.from(new Set(out));
      });
      dom.forEach(u=>handlePayload(sessionId, { url: u, note: "dom-final" }));

      // short wait for dynamic scripts to emit
      await new Promise(r=>setTimeout(r, 2000));

    } catch(err) {
      console.error("Crawl error:", err && err.stack || err);
    }
  })();

  const viewer = `/viewer?session=${sessionId}&target=${encodeURIComponent(url)}`;
  res.json({ session: sessionId, viewer });
});

// SSE endpoint
app.get("/stream", (req, res) => {
  const { session } = req.query;
  if (!session || !SESSIONS[session]) return res.status(404).send("Invalid session");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch{} };
  // send history
  SESSIONS[session].results.forEach(r => send({ type: "found", item: r }));
  SESSIONS[session].clients.add(res);
  const keep = setInterval(()=> res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keep);
    if (SESSIONS[session]) SESSIONS[session].clients.delete(res);
  });
});

// viewer page: iframe + live list
app.get("/viewer", (req, res) => {
  const { session, target } = req.query;
  if (!session || !SESSIONS[session] || !target) return res.status(400).send("Missing session or target");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Live Extractor - ${session}</title>
  <style>
    body{margin:0;font-family:Arial,Helvetica,sans-serif;display:flex;flex-direction:column;height:100vh}
    #top{background:#111;color:#fff;padding:8px;display:flex;align-items:center;gap:8px}
    #list{display:flex;flex-direction:column;gap:6px;padding:8px;max-height:160px;overflow:auto;background:#0b0b0b;}
    .item{background:#222;color:#fff;padding:8px;border-radius:6px;display:flex;flex-direction:column}
    .meta{font-size:12px;color:#ddd;margin-bottom:6px}
    iframe{flex:1;border:0;width:100%}
    .controls{margin-left:auto;display:flex;gap:6px}
    a.btn{background:#1e88e5;color:#fff;padding:6px 8px;border-radius:6px;text-decoration:none}
  </style>
  </head><body>
    <div id="top"><strong>Live Captured URLs</strong>
      <div class="controls">
        <button id="clear">Clear</button>
        <a id="copyAll" class="btn" href="#">Copy URLs</a>
      </div>
    </div>
    <div id="list"></div>
    <iframe id="frame" src="${target}"></iframe>
    <script>
      const session="${session}";
      const ev=new EventSource('/stream?session='+encodeURIComponent(session));
      const list=document.getElementById('list');
      const seen={};
      ev.onmessage = m=>{
        try {
          const p=JSON.parse(m.data);
          if (p.type==='found' && p.item) addItem(p.item);
        } catch(e){}
      }
      function addItem(it){
        if (!it || !it.url) return;
        if (seen[it.url]) return;
        seen[it.url]=true;
        const el=document.createElement('div'); el.className='item';
        const meta=document.createElement('div'); meta.className='meta';
        meta.textContent = (it.type||'media') + ' | cdn:' + (it.cdn? 'yes':'no') + ' | playable:' + (it.playable? 'yes':'no') + (it.source? ' | ' + it.source : '');
        const urlEl=document.createElement('div'); urlEl.style.wordBreak='break-all';
        urlEl.textContent = it.url;
        const actions=document.createElement('div'); actions.style.marginTop='6px';
        const open=document.createElement('a'); open.href=it.url; open.target='_blank'; open.textContent='Open'; open.style.marginRight='8px';
        const dl=document.createElement('a'); dl.href=it.url; dl.download=''; dl.textContent='Download'; dl.style.marginRight='8px';
        const copy=document.createElement('button'); copy.textContent='Copy'; copy.onclick=()=>{ navigator.clipboard.writeText(it.url); copy.textContent='Copied'; setTimeout(()=>copy.textContent='Copy',1200); };
        actions.appendChild(open); actions.appendChild(dl); actions.appendChild(copy);
        el.appendChild(meta); el.appendChild(urlEl); el.appendChild(actions);
        list.prepend(el);
      }
      document.getElementById('clear').onclick=()=>{ list.innerHTML=''; Object.keys(seen).forEach(k=>delete seen[k]); };
      document.getElementById('copyAll').onclick= async (e)=>{ e.preventDefault(); const keys=Object.keys(seen); if (!keys.length) return alert('No URLs'); await navigator.clipboard.writeText(keys.join('\\n')); alert('Copied '+keys.length+' URLs'); };
    </script>
  </body></html>`;
  res.send(html);
});

// central payload handler
function handlePayload(sessionId, payload) {
  try {
    if (!sessionId || !SESSIONS[sessionId]) return;
    if (!payload) return;
    if (payload.type === "dom" && Array.isArray(payload.items)) {
      payload.items.forEach(u => pushToSession(sessionId, { url: u, source: "dom" }));
      return;
    }
    if (payload.type === "json-preview" && payload.preview) {
      const matches = (payload.preview || "").match(/https?:\\/\\/[^\\s"']+\\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|jpeg|png|gif|webp)/gi);
      if (matches) matches.forEach(u => pushToSession(sessionId, { url: u, source: "json-preview" }));
      return;
    }
    if (payload.type === "dataurl" && payload.data) {
      pushToSession(sessionId, { url: payload.data, source: payload.note || "dataurl" });
      return;
    }
    if (payload.url) {
      pushToSession(sessionId, { url: payload.url, contentType: payload.ct || payload.contentType, source: payload.note || payload.source });
    }
  } catch(e){}
}

app.listen(PORT, ()=> console.log("Server listening on", PORT));
