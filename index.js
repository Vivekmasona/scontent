import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 3000;

let browser;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      userDataDir: "/tmp/chrome-user-data",
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

    // Capture ALL network requests
    page.on("request", (reqEvent) => {
      const link = reqEvent.url();
      if (!results.includes(link)) {
        results.push(link);
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait few seconds to collect requests
    setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        const title = await page.title().catch(() => "Unknown");
        await page.close().catch(() => {});
        res.json({ title, urls: results });
      }
    }, 10000);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`✅ Server running at http://localhost:${PORT}`)
);
