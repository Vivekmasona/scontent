import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

const app = express();
const PORT = process.env.PORT || 3000;

ffmpeg.setFfmpegPath(ffmpegPath); // set FFmpeg binary path

let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      userDataDir: "/tmp/chrome-user-data",
    });
  }
  return browserPromise;
}

app.get("/download", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Valid URL required" });

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    let videoUrl = null;
    let audioUrl = null;

    page.on("request", (reqEvent) => {
      const link = reqEvent.url();

      if (link.includes("cdninstagram.com") && link.includes(".mp4")) {
        if (link.includes("bytestart=0")) videoUrl = link.replace(/&bytestart=\d+&byteend=\d+/g, "");
        else audioUrl = link.replace(/&bytestart=\d+&byteend=\d+/g, "");
      }

      if (videoUrl && audioUrl) {
        page.close();

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", "attachment; filename=video.mp4");

        // ✅ Merge using fluent-ffmpeg
        ffmpeg()
          .input(videoUrl)
          .input(audioUrl)
          .outputOptions("-c copy")
          .format("mp4")
          .on("error", (err) => console.error("FFmpeg error:", err))
          .pipe(res, { end: true });
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    setTimeout(() => {
      if (!videoUrl || !audioUrl) res.status(404).json({ error: "Video+Audio not found" });
    }, 10000);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`✅ Server running http://localhost:${PORT}`)
);
