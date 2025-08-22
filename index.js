import express from "express";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Instagram CDN Extractor API is running 🚀");
});

app.get("/cdn", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    const html = response.data;

    // try to match video_url first
    let match = html.match(/"video_url":"([^"]+)"/);
    if (!match) {
      // fallback to display_url (for images)
      match = html.match(/"display_url":"([^"]+)"/);
    }

    if (match) {
      const cdnUrl = match[1].replace(/\\u0026/g, "&");
      return res.json({ cdn: cdnUrl });
    }

    return res.status(404).json({ error: "CDN link not found" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
