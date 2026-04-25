#!/usr/bin/env node
// 從 Google My Maps 抓 KML，解析後輸出 data/places.json
// 用法：node scripts/sync-kml.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const MID = '1dl0XbYYAroESOWXVfEBklOdgHTaXwsg';
const KML_URL = `https://www.google.com/maps/d/kml?mid=${MID}&forcekml=1`;

const DATA_DIR = path.join(__dirname, '..', 'data');
const KML_PATH = path.join(DATA_DIR, 'map.kml');
const JSON_PATH = path.join(DATA_DIR, 'places.json');

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// 去掉 CDATA 包裝並 unescape 基本 XML entity
function cleanText(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// 從 styleUrl 抽出顏色 hex，例如 #icon-1602-C2185B-labelson-nodesc → C2185B
function extractColor(styleUrl) {
  if (!styleUrl) return null;
  const m = styleUrl.match(/#icon-\d+-([0-9A-Fa-f]{6})/);
  return m ? m[1].toUpperCase() : null;
}

function parseKml(kml) {
  const mapName = cleanText((kml.match(/<Document>[\s\S]*?<name>([\s\S]*?)<\/name>/) || [])[1]);
  const mapDesc = cleanText((kml.match(/<Document>[\s\S]*?<description>([\s\S]*?)<\/description>/) || [])[1]);

  const categories = [];
  const folderRegex = /<Folder>([\s\S]*?)<\/Folder>/g;
  let fm;
  while ((fm = folderRegex.exec(kml)) !== null) {
    const folderContent = fm[1];
    const folderName = cleanText((folderContent.match(/<name>([\s\S]*?)<\/name>/) || [])[1]);

    const places = [];
    const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/g;
    let pm;
    while ((pm = placemarkRegex.exec(folderContent)) !== null) {
      const c = pm[1];
      const name = cleanText((c.match(/<name>([\s\S]*?)<\/name>/) || [])[1]);
      const desc = cleanText((c.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
      const styleUrl = cleanText((c.match(/<styleUrl>([\s\S]*?)<\/styleUrl>/) || [])[1]);
      const coordsRaw = cleanText((c.match(/<coordinates>([\s\S]*?)<\/coordinates>/) || [])[1]);

      if (!coordsRaw) continue;
      const [lng, lat] = coordsRaw.split(',').map(parseFloat);
      if (isNaN(lat) || isNaN(lng)) continue;

      places.push({
        name,
        description: desc,
        lat,
        lng,
        color: extractColor(styleUrl),
      });
    }

    if (places.length > 0) {
      categories.push({ name: folderName, places });
    }
  }

  return {
    mapName,
    description: mapDesc,
    updatedAt: new Date().toISOString(),
    totalPlaces: categories.reduce((n, c) => n + c.places.length, 0),
    categories,
  };
}

async function main() {
  console.log('下載 KML...');
  const kml = await download(KML_URL);
  fs.writeFileSync(KML_PATH, kml, 'utf8');
  console.log(`  → ${KML_PATH} (${kml.length} bytes)`);

  console.log('解析 KML...');
  const data = parseKml(kml);
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  → ${JSON_PATH}`);
  console.log(`  地圖名稱：${data.mapName}`);
  console.log(`  分類數：${data.categories.length}`);
  console.log(`  地標總數：${data.totalPlaces}`);
  data.categories.forEach((c) => {
    console.log(`    - ${c.name}：${c.places.length}`);
  });
}

main().catch((err) => {
  console.error('同步失敗：', err);
  process.exit(1);
});
