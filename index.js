import express from "express";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => res.send("IG CDN Extractor running ✅"));

// Function to decode escape characters
function decode(str) {
  return str.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
}

app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.instagram.com/",
      },
    });

    let cdn = null;

    // 1️⃣ First try ld+json
    const ldJsonMatch = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
    );
    if (ldJsonMatch) {
      try {
        const ldJson = JSON.parse(ldJsonMatch[1]);
        if (ldJson.video && ldJson.video.contentUrl) {
          cdn = ldJson.video.contentUrl;
        } else if (ldJson.image && ldJson.image[0]) {
          cdn = ldJson.image[0];
        }
      } catch (e) {
        console.error("ld+json parse fail:", e.message);
      }
    }

    // 2️⃣ Fallback: video_url or display_url regex
    if (!cdn) {
      let match =
        html.match(/"video_url":"([^"]+)"/) ||
        html.match(/"display_url":"([^"]+)"/);
      if (match) cdn = decode(match[1]);
    }

    if (!cdn) {
      return res.status(404).json({ error: "CDN link not found" });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.json({ cdn });
  } catch (e) {
    return res.status(500).json({ error: "fetch_failed", detail: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
