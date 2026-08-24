import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      userDataDir: "/tmp/chrome-user-data",
    });
  }
  return browserPromise;
}

app.get("/extract", async (req, res) => {
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Valid URL required in query (?url=https://...)" });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    const apiUrls = new Set();

    // 1. Capture All XHR & Fetch Requests (Network Level)
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      const reqUrl = request.url();

      // Static assets (images, css, fonts) ko ignore karke sirf API/XHR/Fetch capture karein
      if (["xhr", "fetch"].includes(resourceType)) {
        apiUrls.add(reqUrl);
      }
    });

    // 2. Capture API Responses
    page.on("response", (response) => {
      const respUrl = response.url();
      const contentType = response.headers()["content-type"] || "";

      // Agar response JSON ya XML format me hai, matlab wo backend API URL hai
      if (contentType.includes("application/json") || contentType.includes("application/xml")) {
        apiUrls.add(respUrl);
      }
    });

    // Navigate to page
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    await page.close();

    // Direct JSON Response Array
    return res.json({
      target_site: url,
      total_backend_apis_found: apiUrls.size,
      backend_urls: Array.from(apiUrls)
    });

  } catch (err) {
    console.error("Error extracting APIs:", err.message);
    return res.status(500).json({ error: "Failed to extract backend URLs", details: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ API Detector running on port ${PORT}`));

