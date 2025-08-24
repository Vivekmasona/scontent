import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Valid URL required" });

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // sabhi requests collect karne ke liye array
    const collectedLinks = [];

    page.on("request", (req) => {
      const link = req.url();
      collectedLinks.push(link);
    });

    // page open karo
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // 30 sec tak ruk ke sab requests capture karo
    await new Promise(r => setTimeout(r, 30000));

    await browser.close();

    // duplicates hatao aur index number add karo
    const uniqueLinks = [...new Set(collectedLinks)];
    const numbered = uniqueLinks.map((l, i) => ({ no: i + 1, link: l }));

    res.json({
      url,
      total: numbered.length,
      links: numbered
    });

  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running http://localhost:${PORT}`));


