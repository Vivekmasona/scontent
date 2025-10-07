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
      userDataDir: "/tmp/chrome-user-data", // ETXTBSY fix
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
  "vimeo.com"
];

app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Valid URL required" });

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    let results = [];

    // --- Catch network requests
    page.on("response", async (response) => {
      try {
        let link = response.url().replace(/&bytestart=\d+&byteend=\d+/gi, "");
        const mediaRegex = /\.(mp4|webm|m3u8|mp3|aac|ogg|opus|wav)(\?|$)/i;

        if (mediaRegex.test(link) && !results.find(r => r.url === link)) {
          let type = /(mp4|webm|m3u8)/i.test(link) ? "video" : "audio";
          results.push({ url: link, type, source: "network" });
        }

        // XHR JSON parsing
        if (response.request().resourceType() === "xhr") {
          const ct = response.headers()["content-type"] || "";
          if (ct.includes("application/json")) {
            try {
              const data = await response.json();
              const jsonStr = JSON.stringify(data);
              const matches = jsonStr.match(/https?:\/\/[^\s"']+\.(mp4|m3u8|mp3|aac|ogg|opus|wav)/gi);
              if (matches) {
                matches.forEach(l => {
                  l = l.replace(/&bytestart=\d+&byteend=\d+/gi, "");
                  if (!results.find(r => r.url === l)) {
                    let type = /(mp4|webm|m3u8)/i.test(l) ? "video" : "audio";
                    results.push({ url: l, type, source: "xhr-json" });
                  }
                });
              }
            } catch (err) { /* ignore non-JSON */ }
          }
        }
      } catch (err) {
        console.error("Response handler error:", err.message);
      }
    });

    // --- Navigate
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // --- Catch <video> and <audio> tags
    const domMedia = await page.evaluate(() => {
      const elems = [...document.querySelectorAll("video, audio")];
      return elems
        .map(el => {
          const sources = [];
          if (el.src) sources.push(el.src);
          [...el.querySelectorAll("source")].forEach(s => {
            if (s.src) sources.push(s.src);
          });
          return sources;
        })
        .flat();
    });

    domMedia.forEach(link => {
      if (!results.find(r => r.url === link)) {
        let type = link.match(/\.(mp4|webm|m3u8)/i) ? "video" : "audio";
        results.push({ url: link, type, source: "dom" });
      }
    });

    // --- Add page title
    const title = await page.title();
    results = results.map(r => ({ ...r, title: title || "Unknown" }));

    // --- Priority sorting
    const priority = [];
    const normal = [];
    results.forEach(r => {
      if (PRIORITY_DOMAINS.some(d => r.url.includes(d))) priority.push(r);
      else normal.push(r);
    });

    await page.close();
    res.json({ results: [...priority, ...normal] });

  } catch (err) {
    console.error("Error:", err.message);
    res.json({ results: [] });
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
