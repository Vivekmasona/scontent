import express from "express";
import ytDlp from "yt-dlp-exec";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// YAHAN APNI cookies.txt FILE KA POORA CONTENT PASTE KAREIN
const COOKIES_DATA = `# Netscape HTTP Cookie File
# http://curl.haxx.se/rfc/cookie_spec.html
# This is a generated file!  Do not edit.

.youtube.com	TRUE	/	FALSE	1780000000	VISITOR_INFO1_LIVE	xxxxxxxx
.youtube.com	TRUE	/	TRUE	1780000000	LOGIN_INFO	xxxxxxxx
.youtube.com	TRUE	/	TRUE	1780000000	__Secure-3PAPISID	xxxxxxxx
.youtube.com	TRUE	/	TRUE	1780000000	__Secure-3PSID	xxxxxxxx
# Pasted remaining cookies here...`;

// Render server par cookies.txt file generate karein
const cookiesPath = path.join("/tmp", "cookies.txt");
fs.writeFileSync(cookiesPath, COOKIES_DATA);

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

    // YouTube ke liye cookies aur updated player client spoofing pass karein
    if (isYouTube) {
      options.cookies = cookiesPath;
      options.extractorArgs = "youtube:player_client=ios,android,web";
    }

    const output = await ytDlp(url, options);

    const videos = [];
    const audios = [];

    if (output.formats && Array.isArray(output.formats)) {
      output.formats.forEach((fmt) => {
        if (!fmt.url) return;

        if (fmt.vcodec && fmt.vcodec !== "none") {
          videos.push({
            format_id: fmt.format_id,
            quality: fmt.format_note || `${fmt.height || "unknown"}p`,
            ext: fmt.ext,
            resolution: fmt.resolution || (fmt.width ? `${fmt.width}x${fmt.height}` : "N/A"),
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            download_url: fmt.url
          });
        } else if (fmt.acodec && fmt.acodec !== "none") {
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

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
