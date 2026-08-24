import express from "express";
import ytDlp from "yt-dlp-exec";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/extract", async (req, res) => {
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL query parameter required (?url=https://...)" });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  try {
    // Universal Extraction using yt-dlp
    const output = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      referer: url
    });

    const videos = [];
    const audios = [];

    // Filter Video & Audio formats
    if (output.formats && Array.isArray(output.formats)) {
      output.formats.forEach((fmt) => {
        // Direct download URL check
        if (!fmt.url) return;

        // Video + Audio / Video-Only formats
        if (fmt.vcodec && fmt.vcodec !== "none") {
          videos.push({
            format_id: fmt.format_id,
            quality: fmt.format_note || `${fmt.height || "unknown"}p`,
            ext: fmt.ext,
            resolution: fmt.resolution || (fmt.width ? `${fmt.width}x${fmt.height}` : "N/A"),
            fps: fmt.fps || null,
            file_size_mb: fmt.filesize ? (fmt.filesize / (1024 * 1024)).toFixed(2) : "Unknown",
            download_url: fmt.url
          });
        }
        // Audio-Only formats
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

    // Direct Best Video Fallback (If formats array is empty)
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
      title: output.title || output.fulltitle || "Media File",
      duration_seconds: output.duration || null,
      thumbnail: output.thumbnail || (output.thumbnails && output.thumbnails[0]?.url) || null,
      uploader: output.uploader || output.uploader_id || "Unknown",
      source_site: output.extractor_key || "Universal Engine",
      summary: {
        total_video_formats: videos.length,
        total_audio_formats: audios.length
      },
      data: {
        videos: videos.reverse(), // Highest resolution first
        audios: audios.reverse()  // Highest audio quality first
      }
    });

  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: "Extraction failed. Invalid link or private video.",
      details: err.message
    });
  }
});

app.listen(PORT, () => console.log(`🚀 Universal Media Extractor Running on Port ${PORT}`));

