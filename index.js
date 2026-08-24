import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/extract", async (req, res) => {
  let { url } = req.query;

  if (!url) return res.status(400).json({ error: "URL query parameter required (?url=https://...)" });
  if (!url.startsWith("http")) url = "https://" + url;

  let browser;
  try {
    // Render compatible chromium initialization
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote"
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    const backendApis = new Set();

    // Set User-Agent to avoid initial bot blocks
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    // Capture dynamic Fetch and XHR calls
    page.on("request", (request) => {
      const type = request.resourceType();
      const reqUrl = request.url();

      if (["fetch", "xhr"].includes(type)) {
        if (!reqUrl.includes("google-analytics") && !reqUrl.includes("facebook.com")) {
          backendApis.add(reqUrl);
        }
      }
    });

    // Navigate to page
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await new Promise((r) => setTimeout(r, 3000)); // Wait for JS execution

    await browser.close();

    return res.json({
      target_site: url,
      total_backend_found: backendApis.size,
      backend_urls: Array.from(backendApis)
    });

  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({
      error: "Extraction Failed",
      details: err.message
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
