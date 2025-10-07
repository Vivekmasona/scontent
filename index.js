import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
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

const PRIORITY_DOMAINS = [
  "youtube.com", "youtu.be",
  "scontent", "cdninstagram",
  "fbcdn.net", "facebook.com",
  "twitter.com", "twimg.com",
  "soundcloud.com",
  "vimeo.com",
  "googlevideo.com",
  "play.google.com",
];

const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mkv|mp3|aac|ogg|opus|wav|flac|m4a|jpg|jpeg|png|gif|bmp|webp)(\?|$)/i;
const SMALL_DATAURL_LIMIT_BYTES = 200 * 1024; // avoid huge data-urls

app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Valid URL required" });

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    // Inject script before any page scripts run to capture dynamic behavior.
    await page.evaluateOnNewDocument(() => {
      (function () {
        const send = (obj) => {
          try {
            // prefix so Node can filter
            console.log("CAPTURE_MEDIA::" + JSON.stringify(obj));
          } catch (e) { /* ignore */ }
        };

        // Patch URL.createObjectURL - try to read blob as dataURL (async)
        try {
          const origCreate = URL.createObjectURL.bind(URL);
          URL.createObjectURL = function (obj) {
            try {
              if (obj && obj instanceof Blob) {
                // convert small blobs to dataURL and send (async)
                const r = new FileReader();
                r.onload = function () {
                  try { send({ type: "dataurl", data: r.result, note: "from-createObjectURL" }); } catch (e) { }
                };
                // don't read huge blobs
                if (obj.size && obj.size < 300 * 1024) r.readAsDataURL(obj);
              }
            } catch (e) { }
            return origCreate(obj);
          };
        } catch (e) { }

        // Patch fetch to sniff response urls + content-types
        try {
          const origFetch = window.fetch.bind(window);
          window.fetch = function (...args) {
            const p = origFetch(...args);
            p.then(async (resp) => {
              try {
                const ct = resp.headers.get && resp.headers.get("content-type") || "";
                const u = resp.url || (args[0] || "");
                if (ct.includes("video") || ct.includes("audio") || ct.includes("image") || /m3u8|mpegurl|application\/vnd\.apple\.mpegurl/i.test(ct) || (u && u.match(/\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|png|gif)/i))) {
                  send({ type: "url", url: u, contentType: ct, note: "fetch" });
                }
                // Try to convert small responses to blob/dataURL (non-blocking)
                try {
                  const clone = resp.clone();
                  if ((ct && (ct.includes("video")||ct.includes("audio")||ct.includes("image"))) && typeof clone.blob === "function") {
                    const b = await clone.blob();
                    if (b && b.size && b.size < 200 * 1024) { // small safety limit
                      const r = new FileReader();
                      r.onload = () => send({ type: "dataurl", data: r.result, url: u, contentType: ct, note: "fetch-blob-small" });
                      r.readAsDataURL(b);
                    }
                  }
                } catch(e){}
              } catch (e) { }
            }).catch(()=>{});
            return p;
          };
        } catch (e) { }

        // Patch XMLHttpRequest to capture XHRs
        try {
          const origOpen = window.XMLHttpRequest.prototype.open;
          window.XMLHttpRequest.prototype.open = function (method, url) {
            this._captureUrl = url;
            try { return origOpen.apply(this, arguments); } catch(e) {}
          };
          const origSend = window.XMLHttpRequest.prototype.send;
          window.XMLHttpRequest.prototype.send = function () {
            this.addEventListener && this.addEventListener("load", function () {
              try {
                const ct = this.getResponseHeader && this.getResponseHeader("content-type") || "";
                const u = this._captureUrl || "";
                if (ct.includes("video") || ct.includes("audio") || ct.includes("image") || u.match(/\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|png|gif)/i)) {
                  send({ type: "url", url: u, contentType: ct, note: "xhr" });
                }
                // If response is JSON that might contain media links, try to send a trimmed JSON string
                try {
                  if (ct.includes("application/json") && this.responseText) {
                    const trimmed = this.responseText.slice(0, 10000);
                    send({ type: "maybe-json", url: u, preview: trimmed, note: "xhr-json-preview" });
                  }
                } catch(e){}
              } catch (e) { }
            });
            try { return origSend.apply(this, arguments); } catch(e) {}
          };
        } catch (e) { }

        // Patch MediaSource / SourceBuffer to observe appended segments (truncate!)
        try {
          if (window.MediaSource && window.SourceBuffer) {
            const origAddSource = window.MediaSource.prototype.addSourceBuffer;
            window.MediaSource.prototype.addSourceBuffer = function (mimeType) {
              const sb = origAddSource.apply(this, arguments);
              try {
                const origAppend = sb.appendBuffer;
                sb.appendBuffer = function (buffer) {
                  try {
                    // slice a small part for debugging
                    const slice = buffer && buffer.byteLength ? buffer.slice(0, 64 * 1024) : buffer;
                    const blob = new Blob([slice]);
                    if (blob.size < 200 * 1024) {
                      const r = new FileReader();
                      r.onload = () => {
                        send({ type: "mse-segment", mimeType, snippet: r.result.slice(0, 5000), note: "mse-append-snippet" });
                      };
                      r.readAsDataURL(blob);
                    } else {
                      send({ type: "mse-segment", mimeType, size: blob.size, note: "mse-append-large" });
                    }
                  } catch (e) { }
                  return origAppend.apply(this, arguments);
                };
              } catch (e) { }
              return sb;
            };
          }
        } catch (e) { }

        // Observe DOM <video>, <audio>, <img> element src or source children
        try {
          const collect = () => {
            const out = [];
            document.querySelectorAll("video, audio").forEach(el => {
              const list = new Set();
              if (el.currentSrc) list.add(el.currentSrc);
              if (el.src) list.add(el.src);
              el.querySelectorAll && el.querySelectorAll("source").forEach(s => s.src && list.add(s.src));
              list.forEach(u => out.push({ type: el.tagName.toLowerCase(), url: u, note: "dom-element" }));
            });
            document.querySelectorAll("img").forEach(img => {
              if (img.src) out.push({ type: "image", url: img.src, note: "dom-img" });
            });
            if (out.length) send({ type: "dom-collection", items: out });
          };
          // initial collect + mutation observer for later added elements
          collect();
          const mo = new MutationObserver((m) => collect());
          mo.observe(document, { childList: true, subtree: true });
        } catch (e) { }

      })();
    });

    const results = [];
    const seen = new Set();

    // helper to push results safely
    function pushResult(obj) {
      if (!obj || !obj.url) return;
      const key = obj.url + "|" + (obj.type || "");
      if (seen.has(key)) return;
      seen.add(key);
      // normalize type
      let t = obj.type || "media";
      if (t === "image" || (obj.contentType && obj.contentType.startsWith("image"))) t = "image";
      else if (t === "audio" || (obj.contentType && obj.contentType.startsWith("audio"))) t = "audio";
      else if (t === "video" || (obj.contentType && obj.contentType.startsWith("video"))) t = "video";
      else {
        // guess from extension
        if (obj.url.match(/\.(mp4|webm|m3u8|mkv)/i)) t = "video";
        else if (obj.url.match(/\.(mp3|aac|ogg|opus|wav|m4a|flac)/i)) t = "audio";
        else if (obj.url.match(/\.(jpg|jpeg|png|gif|webp|bmp)/i)) t = "image";
      }
      results.push({
        url: obj.url,
        type: t,
        source: obj.source || obj.note || "detected",
        contentType: obj.contentType || null,
        title: null,
      });
    }

    // Capture console messages from the page (the injected script uses a JSON prefix)
    page.on("console", async (message) => {
      try {
        const txt = message.text();
        if (!txt || !txt.startsWith("CAPTURE_MEDIA::")) return;
        const payload = JSON.parse(txt.replace(/^CAPTURE_MEDIA::/, ""));
        // payload types: url, dataurl, dom-collection, mse-segment, maybe-json
        if (payload.type === "url") {
          pushResult({ url: payload.url, type: payload.contentType && payload.contentType.startsWith("image") ? "image" : undefined, source: payload.note || "page" });
        } else if (payload.type === "dataurl") {
          // convert data URL to a pseudo-url (data:) so client can download
          pushResult({ url: payload.data, type: "media", source: payload.note || "dataurl" });
        } else if (payload.type === "dom-collection" && Array.isArray(payload.items)) {
          payload.items.forEach(it => pushResult({ url: it.url, type: it.type, source: it.note || "dom" }));
        } else if (payload.type === "maybe-json" && payload.preview) {
          // try to extract media urls from preview snippet
          const matches = (payload.preview || "").match(/https?:\/\/[^\s"']+\.(mp4|webm|m3u8|mp3|aac|ogg|opus|wav|jpg|jpeg|png|gif|webp)/gi);
          if (matches) matches.forEach(u => pushResult({ url: u, source: "json-preview" }));
        } else if (payload.type === "mse-segment") {
          // snippet only - not a full URL; store as debug item
          pushResult({ url: "data:application/octet-stream;base64," + (payload.snippet ? Buffer.from(payload.snippet.slice(0,100)).toString("base64") : ""), type: "video", source: "mse-snippet" });
        }
      } catch (e) { /* ignore parse errors */ }
    });

    // Also inspect responses for content-type or direct media URL patterns
    page.on("response", async (response) => {
      try {
        const rurl = response.url().replace(/&bytestart=\d+&byteend=\d+/gi, "");
        const headers = response.headers();
        const ct = headers["content-type"] || headers["Content-Type"] || "";
        if (ct && (ct.includes("video") || ct.includes("audio") || ct.includes("image") || /m3u8|mpegurl|application\/vnd\.apple\.mpegurl/i.test(ct))) {
          pushResult({ url: rurl, contentType: ct, source: "network-response" });
        } else if (MEDIA_EXT_RE.test(rurl)) {
          pushResult({ url: rurl, source: "network-response-ext" });
        } else {
          // if xhr/json responses may contain links -> try to parse small JSON bodies
          const req = response.request();
          if (req && req.resourceType && req.resourceType() === "xhr" && ct.includes("application/json")) {
            try {
              const json = await response.text();
              const matches = (json || "").match(/https?:\/\/[^\s"']+\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|jpeg|png|gif|webp)/gi);
              if (matches) matches.forEach(u => pushResult({ url: u, source: "xhr-json" }));
            } catch (e) { }
          }
        }
      } catch (e) { /* ignore */ }
    });

    // requestfinished sometimes helps find final redirected urls (like googlevideo)
    page.on("requestfinished", (req) => {
      try {
        const r = req.response();
        if (!r) return;
        const rurl = req.url().replace(/&bytestart=\d+&byteend=\d+/gi, "");
        const headers = r.headers();
        const ct = headers["content-type"] || headers["Content-Type"] || "";
        if (ct && (ct.includes("video") || ct.includes("audio") || ct.includes("image"))) {
          pushResult({ url: rurl, contentType: ct, source: "requestfinished" });
        } else if (MEDIA_EXT_RE.test(rurl)) {
          pushResult({ url: rurl, source: "requestfinished-ext" });
        }
      } catch (e) { }
    });

    // Navigate the page
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }).catch(()=>{});

    // Grab DOM media sources explicitly after load
    const domMedia = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("video, audio").forEach(el => {
        const set = new Set();
        if (el.src) set.add(el.src);
        if (el.currentSrc) set.add(el.currentSrc);
        el.querySelectorAll && el.querySelectorAll("source").forEach(s => s.src && set.add(s.src));
        set.forEach(u => out.push({ url: u, tag: el.tagName.toLowerCase() }));
      });
      document.querySelectorAll("img").forEach(img => img.src && out.push({ url: img.src, tag: "img" }));
      // also pick up source tags outside media elements
      document.querySelectorAll("source").forEach(s => s.src && out.push({ url: s.src, tag: "source" }));
      return out;
    });

    domMedia.forEach(d => pushResult({ url: d.url, type: d.tag === "img" ? "image" : undefined, source: "dom-scan" }));

    // Wait a little bit to give the page's dynamic scripts time to trigger our hooks (XHR/fetch/MSE)
    await new Promise(r => setTimeout(r, 1800));

    // Add page title to results
    const title = await page.title().catch(() => "Unknown");
    results.forEach(r => r.title = title || "Unknown");

    // priority sort
    const priority = [];
    const normal = [];
    results.forEach(r => {
      if (PRIORITY_DOMAINS.some(d => (r.url || "").includes(d))) priority.push(r);
      else normal.push(r);
    });

    await page.close();
    res.json({ results: [...priority, ...normal] });

  } catch (err) {
    console.error("Error in /cdn:", err && err.stack || err);
    res.json({ results: [] });
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
