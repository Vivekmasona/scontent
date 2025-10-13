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

// ---- CDN endpoint ----
app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Valid URL required" });

  try {
    // Stream output immediately to client
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.write(`🔍 Scanning: ${url}\n\n`);

    const browser = await getBrowser();
    const page = await browser.newPage();

    const results = [];
    const seen = new Set();

    // pushResult also writes live updates
    function pushResult(obj) {
      if (!obj || !obj.url) return;
      const key = obj.url + "|" + (obj.type || "");
      if (seen.has(key)) return;
      seen.add(key);

      // auto-detect type
      let t = "other";
      const u = obj.url.toLowerCase();
      if (u.match(/\.(mp4|webm|mkv|m3u8)/i)) t = "video";
      else if (u.match(/\.(mp3|aac|ogg|opus|wav|flac|m4a)/i)) t = "audio";
      else if (u.match(/\.(jpg|jpeg|png|gif|webp|bmp)/i)) t = "image";

      results.push({ ...obj, type: t });
      res.write(`📡 [${t.toUpperCase()}] ${obj.url}\n`);
    }

    page.on("console", async (message) => {
      const txt = message.text();
      if (!txt.startsWith("CAPTURE_MEDIA::")) return;
      try {
        const payload = JSON.parse(txt.replace(/^CAPTURE_MEDIA::/, ""));
        if (payload.type === "url" && payload.url) {
          pushResult({ url: payload.url, source: payload.note || "fetch" });
        } else if (payload.type === "dom-collection" && Array.isArray(payload.items)) {
          payload.items.forEach(it => pushResult({ url: it.url, source: it.note || "dom" }));
        }
      } catch (e) {}
    });

    page.on("response", async (response) => {
      try {
        const rurl = response.url();
        const headers = response.headers();
        const ct = headers["content-type"] || "";
        if (ct.match(/video|audio|image/i) || MEDIA_EXT_RE.test(rurl)) {
          pushResult({ url: rurl, contentType: ct, source: "network" });
        }
      } catch (e) {}
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const title = await page.title().catch(() => "Unknown");

    // Sort and group results
    const categorized = {
      video: [],
      audio: [],
      image: [],
      other: []
    };
    results.forEach(r => {
      const list = categorized[r.type] || categorized.other;
      list.push({ ...r, title });
    });

    await page.close();

    res.write(`\n✅ Done! Found ${results.length} items.\n\n`);
    res.write(JSON.stringify(categorized, null, 2));
    res.end();

  } catch (err) {
    console.error("Error in /cdn:", err);
    res.status(500).end("Error: " + err.message);
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
