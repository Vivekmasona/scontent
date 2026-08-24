import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/extract", async (req, res) => {
  let { url } = req.query;

  if (!url) return res.status(400).json({ error: "URL query parameter required" });
  if (!url.startsWith("http")) url = "https://" + url;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--js-flags=--max-old-space-size=256"
      ]
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();
    const backendApis = new Set();

    page.on("request", (request) => {
      const type = request.resourceType();
      const reqUrl = request.url();

      if (["fetch", "xhr"].includes(type)) {
        if (!reqUrl.includes("google-analytics") && !reqUrl.includes("facebook")) {
          backendApis.add(reqUrl);
        }
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(3000);

    await browser.close();

    return res.json({
      target_site: url,
      total_backend_found: backendApis.size,
      backend_urls: Array.from(backendApis)
    });

  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: "Extraction Failed", details: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
