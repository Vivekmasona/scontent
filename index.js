import axios from "axios";

async function getInstagramMedia(url) {
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });

  const html = res.data;
  const jsonMatch = html.match(/"video_url":"([^"]+)"/) || html.match(/"display_url":"([^"]+)"/);
  if (jsonMatch) {
    return jsonMatch[1].replace(/\\u0026/g, "&");
  }
  return null;
}

getInstagramMedia("https://www.instagram.com/reel/C4w8Qz6sHY9/")
  .then(link => console.log("CDN Link:", link));
