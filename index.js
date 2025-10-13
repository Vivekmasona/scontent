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

const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mkv|mp3|aac|ogg|opus|wav|flac|m4a|jpg|jpeg|png|gif|bmp|webp)(\?|$)/i;

// Helper: Clean Instagram / CDN URLs
function cleanURL(url) {
  try {
    const u = new URL(url);
    ["bytestart", "byteend", "range"].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return url;
  }
}

// ---- CDN / media extraction endpoint ----
app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("<h3>⚠️ URL required ?url=https://...</h3>");

  const startTime = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();

  const results = [];
  const seen = new Set();

  function pushResult(obj) {
    if (!obj?.url) return;
    let url = cleanURL(obj.url);
    if (seen.has(url)) return;
    seen.add(url);

    let type = "other";
    const u = url.toLowerCase();
    if (u.match(/\.(mp4|webm|mkv|m3u8)/)) type = "video";
    else if (u.match(/\.(mp3|aac|ogg|opus|wav|m4a|flac)/)) type = "audio";
    else if (u.match(/\.(jpg|jpeg|png|gif|webp|bmp)/)) type = "image";

    results.push({ url, type, source: obj.source || "page" });
  }

  // Listen for network responses
  page.on("response", async (response) => {
    try {
      const rurl = response.url();
      const headers = response.headers();
      const ct = headers["content-type"] || "";
      if (ct.match(/video|audio|image/i) || MEDIA_EXT_RE.test(rurl) || rurl.includes("cdn")) {
        pushResult({ url: rurl, contentType: ct });
      }
    } catch {}
  });

  // Navigate page
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  const title = await page.title().catch(() => "Unknown");
  await page.close();

  // Group by type
  const grouped = { video: [], image: [], audio: [], other: [] };
  results.forEach(r => grouped[r.type].push(r));

  // --- HTML page generation ---
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const gradient = "linear-gradient(135deg,#3a1c71,#d76d77,#ffaf7b)";

  const mediaHTML = (arr, type) =>
    arr.length === 0
      ? `<p class="empty">No ${type} found.</p>`
      : arr.map(r => `
        <div class="card">
          ${type === "video"
            ? `<video controls src="${r.url}"></video>`
            : type === "audio"
            ? `<audio controls src="${r.url}"></audio>`
            : type === "image"
            ? `<img src="${r.url}"/>`
            : `<div class="other">${r.url}</div>`}
          <div class="actions">
            <button onclick="window.open('${r.url}','_blank')">Open</button>
            <button onclick="copyURL('${r.url}')">Copy</button>
          </div>
        </div>
      `).join("\n");

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>CDN Extractor - ${title}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0;font-family:sans-serif;}
      body{background:${gradient};min-height:100vh;color:#fff;display:flex;flex-direction:column;}
      header{padding:1rem;text-align:center;font-size:1.2rem;font-weight:600;background:rgba(0,0,0,0.3);position:sticky;top:0;backdrop-filter:blur(5px);}
      .tabs{display:flex;justify-content:center;margin-top:0.5rem;gap:0.5rem;flex-wrap:wrap;}
      .tab{background:#ffffff22;border:1px solid #fff4;border-radius:999px;padding:0.4rem 1rem;cursor:pointer;}
      .tab.active{background:#fff;color:#333;}
      #bar{height:4px;width:0%;background:#fff;transition:width .4s;position:absolute;top:0;left:0;}
      .content{padding:1rem;display:none;flex-wrap:wrap;gap:1rem;justify-content:center;}
      .content.active{display:flex;}
      .card{background:#ffffff22;border-radius:1rem;overflow:hidden;backdrop-filter:blur(4px);padding:0.5rem;width:280px;display:flex;flex-direction:column;align-items:center;}
      video,img,audio{max-width:100%;border-radius:0.5rem;margin-bottom:0.5rem;}
      .actions{display:flex;gap:0.5rem;}
      button{background:#fff;color:#333;border:none;border-radius:0.5rem;padding:0.4rem 0.8rem;cursor:pointer;font-weight:600;}
      button:hover{background:#eee;}
      .other{word-break:break-all;padding:0.5rem;text-align:center;}
      .empty{text-align:center;width:100%;opacity:0.8;}
      footer{margin-top:auto;text-align:center;padding:0.5rem;font-size:0.8rem;opacity:0.7;}
    </style>
  </head>
  <body>
    <div id="bar"></div>
    <header>CDN Extractor | <small>${elapsed}s</small>
      <div class="tabs">
        <div class="tab active" onclick="showTab('video')">🎥 Video (${grouped.video.length})</div>
        <div class="tab" onclick="showTab('image')">🖼️ Image (${grouped.image.length})</div>
        <div class="tab" onclick="showTab('audio')">🎧 Audio (${grouped.audio.length})</div>
        <div class="tab" onclick="showTab('other')">📦 Other (${grouped.other.length})</div>
      </div>
    </header>

    <div id="video" class="content active">${mediaHTML(grouped.video, "video")}</div>
    <div id="image" class="content">${mediaHTML(grouped.image, "image")}</div>
    <div id="audio" class="content">${mediaHTML(grouped.audio, "audio")}</div>
    <div id="other" class="content">${mediaHTML(grouped.other, "other")}</div>

    <footer>© ${new Date().getFullYear()} CDN Capture | Total ${results.length} links</footer>

    <script>
      let progress = 0;
      const bar = document.getElementById('bar');
      const intv = setInterval(() => {
        if (progress < 100) progress += 5;
        bar.style.width = progress + '%';
        if (progress >= 100) clearInterval(intv);
      }, 200);

      function showTab(id){
        document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
        document.querySelectorAll('.content').forEach(c=>c.classList.remove('active'));
        document.querySelector('.tab[onclick*="'+id+'"]').classList.add('active');
        document.getElementById(id).classList.add('active');
      }

      function copyURL(text){
        navigator.clipboard.writeText(text);
        alert("Copied: " + text);
      }
    </script>
  </body>
  </html>
  `;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Start server
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
