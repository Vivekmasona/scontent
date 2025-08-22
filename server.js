import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
const PORT = process.env.PORT || 3000;

let browserPromise; // 🔥 global browser instance

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      userDataDir: "/tmp/chrome-user-data", // important for ETXTBSY fix
    });
  }
  return browserPromise;
}

app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Valid URL required" });

  try {
    const browser = await getBrowser(); // reuse browser
    const page = await browser.newPage();

    let resolved = false;
    let links = [];

    page.on("request", (reqEvent) => {
      let link = reqEvent.url();

      if (link.includes("videoplayback") && link.includes("expire=")) {
        if (!links.includes(link)) links.push(link);
      }

      if (
        (link.includes("cdninstagram.com") || link.includes("fbcdn.net")) &&
        link.includes(".mp4")
      ) {
        link = link.replace(/&bytestart=\d+&byteend=\d+/g, "");
        if (!links.includes(link)) links.push(link);
      }

      if (links.length >= 4 && !resolved) {
        resolved = true;
        page.close(); // ✅ sirf page band karo, browser mat
        return res.json({ links: links.slice(0, 4) });
      }
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        page.close();
        if (links.length > 0) {
          res.json({ links: links.slice(0, 4) });
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
  console.log(`✅ Server running http://localhost:${PORT}`)
);
