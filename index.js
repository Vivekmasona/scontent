import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

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

const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mkv|mp3|aac|ogg|opus|wav|flac|m4a|jpg|jpeg|png|gif|bmp|webp)(\?|$)/i;

// Clean URLs (Instagram / CDN)
function cleanURL(url) {
  try {
    const u = new URL(url);
    ["bytestart", "byteend", "range"].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return url;
  }
}

// Serve static HTML page
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Live CDN Dashboard</title>
<style>
body{margin:0;font-family:sans-serif;background:linear-gradient(135deg,#3a1c71,#d76d77,#ffaf7b);color:#fff;display:flex;flex-direction:column;min-height:100vh;}
header{padding:1rem;text-align:center;font-weight:bold;position:sticky;top:0;background:rgba(0,0,0,0.3);backdrop-filter:blur(5px);}
.tabs{display:flex;gap:0.5rem;justify-content:center;margin-top:0.5rem;}
.tab{padding:0.4rem 1rem;border-radius:999px;background:#ffffff22;cursor:pointer;}
.tab.active{background:#fff;color:#333;}
#bar{height:4px;width:0%;background:#fff;transition:width .4s;position:absolute;top:0;left:0;}
.content{display:flex;flex-wrap:wrap;gap:1rem;justify-content:center;padding:1rem;flex-grow:1;}
.content.hidden{display:none;}
.card{background:#ffffff22;border-radius:1rem;padding:0.5rem;width:280px;display:flex;flex-direction:column;align-items:center;backdrop-filter:blur(4px);}
video,img,audio{max-width:100%;border-radius:0.5rem;margin-bottom:0.5rem;}
.actions{display:flex;gap:0.5rem;}
button{background:#fff;color:#333;border:none;border-radius:0.5rem;padding:0.4rem 0.8rem;cursor:pointer;font-weight:600;}
button:hover{background:#eee;}
footer{padding:0.5rem;text-align:center;opacity:0.7;}
</style>
</head>
<body>
<div id="bar"></div>
<header>
Live CDN Media Dashboard
<div class="tabs">
  <div class="tab active" onclick="showTab('video')">🎥 Video (<span id="count-video">0</span>)</div>
  <div class="tab" onclick="showTab('image')">🖼️ Image (<span id="count-image">0</span>)</div>
  <div class="tab" onclick="showTab('audio')">🎧 Audio (<span id="count-audio">0</span>)</div>
  <div class="tab" onclick="showTab('other')">📦 Other (<span id="count-other">0</span>)</div>
</div>
</header>

<div id="video" class="content"></div>
<div id="image" class="content hidden"></div>
<div id="audio" class="content hidden"></div>
<div id="other" class="content hidden"></div>

<footer id="footer">Status: waiting for URLs...</footer>

<script>
let counts = {video:0,image:0,audio:0,other:0};
function showTab(id){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.content').forEach(c=>c.classList.add('hidden'));
  document.querySelector('.tab[onclick*="'+id+'"]').classList.add('active');
  document.getElementById(id).classList.remove('hidden');
}
function copyURL(url){
  navigator.clipboard.writeText(url);
  alert('Copied: '+url);
}

// SSE
const evtSource = new EventSource('/events');
evtSource.onmessage = function(event){
  try{
    const data = JSON.parse(event.data);
    const type = data.type || 'other';
    const container = document.getElementById(type);
    const card = document.createElement('div');
    card.className = 'card';
    if(type==='video') card.innerHTML = \`<video controls src="\${data.url}"></video>\`;
    else if(type==='audio') card.innerHTML = \`<audio controls src="\${data.url}"></audio>\`;
    else if(type==='image') card.innerHTML = \`<img src="\${data.url}"/>\`;
    else card.innerHTML = \`<div class="other">\${data.url}</div>\`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.innerHTML = \`<button onclick="window.open('\${data.url}','_blank')">Open</button><button onclick="copyURL('\${data.url}')">Copy</button>\`;
    card.appendChild(actions);
    container.appendChild(card);

    counts[type]++; 
    document.getElementById('count-'+type).innerText = counts[type];
    document.getElementById('footer').innerText = 'Last URL: ' + data.url;
  } catch(e){ console.error(e); }
};
</script>
</body>
</html>
  `);
});

// SSE endpoint for live updates
app.get("/events", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();

  const { url } = req.query;
  if (!url) {
    res.write(`data: ${JSON.stringify({type:'other', url:'No URL provided'})}\n\n`);
    return;
  }

  const browser = await getBrowser();
  const page = await browser.newPage();
  const seen = new Set();

  function pushResult(obj){
    if(!obj?.url) return;
    let url = cleanURL(obj.url);
    if(seen.has(url)) return;
    seen.add(url);
    let type = 'other';
    const u = url.toLowerCase();
    if(u.match(/\.(mp4|webm|mkv|m3u8)/)) type='video';
    else if(u.match(/\.(mp3|aac|ogg|opus|wav|m4a|flac)/)) type='audio';
    else if(u.match(/\.(jpg|jpeg|png|gif|webp|bmp)/)) type='image';
    res.write(`data: ${JSON.stringify({type,url})}\n\n`);
  }

  // Page console log (if needed)
  page.on('console', msg=>{
    try{
      const text = msg.text();
      if(text.startsWith('CAPTURE_MEDIA::')){
        const obj = JSON.parse(text.replace(/^CAPTURE_MEDIA::/,''));
        pushResult(obj);
      }
    }catch{}
  });

  // Capture network responses
  page.on("response", async response => {
    try{
      const rurl = response.url();
      const headers = response.headers();
      const ct = headers["content-type"]||"";
      if(ct.match(/video|audio|image/i) || MEDIA_EXT_RE.test(rurl) || rurl.includes("cdn")) pushResult({url:rurl});
    }catch{}
  });

  // Navigate page
  await page.goto(url, {waitUntil:"networkidle2", timeout:60000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,5000));
  await page.close();
  res.end();
});

app.listen(PORT, () => console.log(`✅ Live CDN server running at http://localhost:${PORT}`));
