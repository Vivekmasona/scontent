import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { spawn } from "child_process";

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
      userDataDir: "/tmp/chrome-user-data",
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

    let videoUrl = null;
    let audioUrl = null;

    page.on("request", (reqEvent) => {
      const link = reqEvent.url();

      if (link.includes("cdninstagram.com") && link.includes(".mp4")) {
        if (link.includes("bytestart=0")) {
          // Usually video-only
          videoUrl = link.replace(/&bytestart=\d+&byteend=\d+/g, "");
        } else {
          // Usually audio-only
          audioUrl = link.replace(/&bytestart=\d+&byteend=\d+/g, "");
        }
      }

      if (videoUrl && audioUrl) {
        page.close();
        // FFmpeg merge call
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", "attachment; filename=video.mp4");

        const ffmpeg = spawn("ffmpeg", [
          "-i", videoUrl,
          "-i", audioUrl,
          "-c", "copy",
          "-f", "mp4",
          "pipe:1",
        ]);

        ffmpeg.stdout.pipe(res);
        ffmpeg.stderr.on("data", (d) => console.error("FFmpeg:", d.toString()));
        ffmpeg.on("close", () => console.log("✅ Merge complete"));
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    setTimeout(() => {
      if (!videoUrl
