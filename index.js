import express from "express";
import ytDlp from "yt-dlp-exec";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// Step 1 me exported cookie ka text content yahan paste karein
const COOKIES_DATA = `# Netscape HTTP Cookie File
# http://curl.haxx.se/rfc/cookie_spec.html
# Paste your raw youtube cookies content here...`;

const cookiesPath = path.join("/tmp", "cookies.txt");

// Render startup par cookies write karna
try {
  fs.writeFileSync(cookiesPath, COOKIES_DATA);
} catch (e) {
  console.error("Failed to write cookies file", e);
}

app.get("/extract", async (req, res) => {
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL query parameter required" });
  }

  try {
    const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

    const options = {
      dumpSingleJson: true,
      noWarnings: true,
      referer: url
    };

    if (isYouTube) {
      // Direct Cookies file pass karein
      options.cookies = cookiesPath;
      // Bot check bypass karne ke liye android/ios client spoofing
      options.extractorArgs = "youtube:player_client=ios,android,mweb";
    }

    const output = await ytDlp(url, options);

    const videos = [];
    const audios = [];

    if (output.formats && Array.isArray(output.formats)) {
      output.formats.forEach((fmt) => {
        if (!fmt.url) return;

        // Video format collection
        if (fmt.vcodec && fmt.vcodec !== "none") {
          videos.push({
            format_id: fmt.format_id,
            quality: fmt.format_note || `${fmt.height || "unknown"}p`,
            ext: fmt.ext,
            resolution: fmt.resolution || (fmt.width ? `${fmt.width}x${fmt.height}` : "N/A"),
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            download_url: fmt.url
          });
        } 
        // Audio format collection
        else if (fmt.acodec && fmt.acodec !== "none") {
          audios.push({
            format_id: fmt.format_id,
            ext: fmt.ext,
            audio_bitrate: fmt.abr ? `${fmt.abr}kbps` : "N/A",
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            download_url: fmt.url
          });
        }
      });
    }

    // Direct stream URL Fallback (Reels, TikTok, Shorts)
    if (videos.length === 0 && output.url) {
      videos.push({
        format_id: "best",
        quality: "HD / Original",
        ext: output.ext || "mp4",
        download_url: output.url
      });
    }

    return res.json({
      status: "success",
      title: output.title || "Media File",
      thumbnail: output.thumbnail || null,
      uploader: output.uploader || "Unknown",
      source_site: output.extractor_key || "Universal Engine",
      summary: {
        total_video_formats: videos.length,
        total_audio_formats: audios.length
      },
      data: {
        videos: videos.reverse(),
        audios: audios.reverse()
      }
    });

  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: "Extraction failed.",
      details: err.message
    });
  }
});

app.listen(PORT, () => console.log(`🚀 Universal Extractor active on port ${PORT}`));
