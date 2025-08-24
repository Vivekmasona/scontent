import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 3000;

let browser; // keep single browser

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      userDataDir: "/tmp/chrome-user-data", // prevent ETXTBSY
    });
  }
  return browser;
}

app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Valid URL required" });

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    let resolved = false;
    let results = [];

    // listen for network requests
    page.on("request", (reqEvent) => {
      let link = reqEvent.url();

      if ((link.includes("cdninstagram.com") || link.includes("fbcdn.net")) && link.match(/\.(mp4|m3u8)/)) {
        link = link.replace(/&bytestart=\d+&byteend=\d+/g, "");
        if (!results.find(r => r.url === link)) results.push({ url: link });
      }

      if (link.match(/\.(mp4|webm|m3u8)/i)) {
        if (!results.find(r => r.url === link)) results.push({ url: link });
      }

      if (results.length >= 5 && !resolved) {
        resolved = true;
        page.title().then(title => {
          results = results.map(r => ({ ...r, title: title || "Unknown" }));
          page.close().catch(() => {});
          res.json({ results: results.slice(0, 5) });
        });
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // fallback timeout
    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        const title = await page.title().catch(() => "Unknown");
        results = results.map(r => ({ ...r, title }));
        await page.close().catch(() => {});
        if (results.length > 0) {
          res.json({ results: results.slice(0, 5) });
        } else {
          res.status(404).json({ error: "Video link not found" });
        }
      }
    }, 10000);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`✅ Server running at http://localhost:${PORT}`)
);
