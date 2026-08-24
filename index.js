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
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }
  return browserPromise;
}

app.get("/extract", async (req, res) => {
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL query parameter required (?url=https://...)" });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    const extracted = {
      videos: new Set(),
      audio: new Set(),
      images: new Set(),
      documents: new Set(),
      backend_apis: new Set(),
      other_links: new Set()
    };

    // Helper function to classify URLs
    const classifyUrl = (reqUrl, contentType = "") => {
      if (!reqUrl || reqUrl.startsWith("data:")) return;

      const lowerUrl = reqUrl.toLowerCase();
      const lowerCT = contentType.toLowerCase();

      // Video Filtering
      if (
        lowerCT.includes("video") ||
        /\.(mp4|m3u8|webm|mkv|flv|avi|mov)(\?|$)/i.test(lowerUrl)
      ) {
        extracted.videos.add(reqUrl);
      }
      // Audio Filtering
      else if (
        lowerCT.includes("audio") ||
        /\.(mp3|aac|wav|ogg|m4a|flac|opus)(\?|$)/i.test(lowerUrl)
      ) {
        extracted.audio.add(reqUrl);
      }
      // Image Filtering
      else if (
        lowerCT.includes("image") ||
        /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp)(\?|$)/i.test(lowerUrl)
      ) {
        extracted.images.add(reqUrl);
      }
      // Document Filtering
      else if (
        lowerCT.includes("pdf") ||
        /\.(pdf|doc|docx|zip|rar|csv)(\?|$)/i.test(lowerUrl)
      ) {
        extracted.documents.add(reqUrl);
      }
      // Backend / API Endpoints Filtering
      else if (
        lowerCT.includes("json") ||
        lowerCT.includes("xml") ||
        lowerUrl.includes("/api/") ||
        lowerUrl.includes("/v1/") ||
        lowerUrl.includes("/v2/") ||
        lowerUrl.includes("graphql")
      ) {
        extracted.backend_apis.add(reqUrl);
      }
      // Catch remaining fetch/xhr calls as general backend links
      else {
        extracted.other_links.add(reqUrl);
      }
    };

    // 1. Intercept Network Requests & Responses
    page.on("response", (response) => {
      try {
        const reqUrl = response.url();
        const contentType = response.headers()["content-type"] || "";
        classifyUrl(reqUrl, contentType);
      } catch (e) {}
    });

    // Navigate to website and wait for dynamic JavaScript load
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    // 2. DOM Elements Extraction (<video>, <audio>, <img>, <a>)
    const domResources = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll("video, audio, source, img, a").forEach((el) => {
        const src = el.src || el.href || el.currentSrc;
        if (src) links.push(src);
      });
      return links;
    });

    domResources.forEach((link) => classifyUrl(link));

    await page.close();

    // Send Categorized JSON Response
    return res.json({
      status: "success",
      target_site: url,
      summary: {
        total_videos: extracted.videos.size,
        total_audio: extracted.audio.size,
        total_images: extracted.images.size,
        total_documents: extracted.documents.size,
        total_backend_apis: extracted.backend_apis.size
      },
      data: {
        videos: Array.from(extracted.videos),
        audio: Array.from(extracted.audio),
        images: Array.from(extracted.images),
        documents: Array.from(extracted.documents),
        backend_apis: Array.from(extracted.backend_apis),
        other_network_calls: Array.from(extracted.other_links)
      }
    });

  } catch (err) {
    if (page) await page.close();
    return res.status(500).json({
      status: "error",
      message: "Extraction failed",
      details: err.message
    });
  }
});

app.listen(PORT, () => console.log(`🚀 Universal Extractor Running on port ${PORT}`));

