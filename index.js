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

app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Valid URL required" });

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    let resolved = false;
    let results = [];

    // Listen all network responses
    page.on("response", async (response) => {
      try {
        let link = response.url();

        // REMOVE &bytestart & byteend params
        link = link.replace(/&bytestart=\d+&byteend=\d+/gi, "");

        // Common audio/video extensions
        if (link.match(/\.(mp4|webm|m3u8|mp3|aac|ogg|opus|wav)(\?|$)/i)) {
          if (!results.find(r => r.url === link)) {
            results.push({ url: link, type: "media" });
          }
        }

        // JSON XHR responses
        if (response.request().resourceType() === "xhr") {
          try {
            const data = await response.json();
            const jsonStr = JSON.stringify(data);

            const matches = jsonStr.match(/https?:\/\/[^\s"']+\.(mp4|m3u8|mp3|aac|ogg|opus|wav)/gi);
            if (matches) {
              matches.forEach(l => {
                // Remove bytestart/byteend from JSON URLs too
                l = l.replace(/&bytestart=\d+&byteend=\d+/gi, "");
                if (!results.find(r => r.url === l)) {
                  results.push({ url: l, type: "json-extracted" });
                }
              });
            }
          } catch { /* ignore non-JSON */ }
        }

      } catch (err) {
        console.error("Response parse error:", err.message);
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });

    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        const title = await page.title();
        results = results.map(r => ({ ...r, title: title || "Unknown" }));
        await page.close();
        if (results.length > 0) {
          res.json({ results });
        } else {
          res.status(404).json({ error: "No audio/video found" });
        }
      }
    }, 12000);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`✅ Server running at http://localhost:${PORT}`)
);
