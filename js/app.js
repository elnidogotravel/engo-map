// 深深攻略地圖 · 前端邏輯

// ── Lucide icon helper ─────────────────
// 從 Lucide UMD 取出 icon data，輸出乾淨的 SVG 字串
function kebabToPascal(name) {
  return name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
}

function nodeToSvgString(node) {
  if (!node) return '';
  const [tag, attrs, children] = node;
  const attrsStr = Object.entries(attrs || {})
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const childStr = (children || [])
    .map((c) => nodeToSvgString(c))
    .join('');
  return childStr
    ? `<${tag} ${attrsStr}>${childStr}</${tag}>`
    : `<${tag} ${attrsStr}/>`;
}

function svg(name) {
  if (typeof lucide === 'undefined') return '';
  const iconData = lucide.icons?.[kebabToPascal(name)];
  if (!iconData) {
    console.warn('Lucide icon not found:', name);
    return '';
  }
  return nodeToSvgString(iconData);
}

// ── 分類對應的 icon + 顏色（Morandi 彩虹）──
const CATEGORY_META = {
  '餐廳推薦':        { icon: 'utensils-crossed', color: '#C47878' }, // 紅：霧紅
  '咖啡小食':        { icon: 'coffee',           color: '#D4B26A' }, // 黃：奶油黃
  '行程地標':        { icon: 'mountain-snow',    color: '#8FB38A' }, // 綠：鼠尾草
  '旅館位置':        { icon: 'bed-double',       color: '#7D9CB8' }, // 藍：霧藍
  '商場＆實用':      { icon: 'shopping-bag',     color: '#8583B8' }, // 靛：靛紫
  '酒吧夜生活':      { icon: 'wine',             color: '#B088B8' }, // 紫：霧紫
};
const ALL_ICON = 'compass';
const PRIMARY_COLOR = '#8CBBCD';
const WARN_PIN_COLOR = '#B84A4A'; // 踩雷 pin 色（比餐廳紅更深更飽和）

// 踩雷偵測：描述含關鍵字才算（顏色在 My Maps 裡被混用，不可靠）
const WARN_KEYWORDS = /踩雷|不要吃|不要去|避開|避雷|地雷|團滅|別去|別吃|不推|不建議/;
function isWarnPlace(place) {
  return WARN_KEYWORDS.test(place.description || '');
}

const DEFAULT_VIEW = { center: [11.1800, 119.3895], zoom: 17 };

let map;
let cluster;
let allPlaces = []; // { place, category, marker }
let currentFilter = '__all__';
let activeMarker = null;

// ── 初始化 ──────────────────────────────
async function init() {
  try {
    const data = await loadData();
    setupTopbarIcons();
    setupMap();
    renderCategories(data.categories);
    renderMarkers(data.categories);
    setupInfoModal(data);
    setupSheetClose();
    setupSearch();
  } catch (err) {
    console.error(err);
    alert('載入地圖失敗，請稍後再試');
  }
}

// ── 頂部按鈕圖示 ─────────────────────────
function setupTopbarIcons() {
  document.getElementById('searchBtn').innerHTML = svg('search');
  document.getElementById('infoBtn').innerHTML = svg('info');
  document.getElementById('searchIconSlot').innerHTML = svg('search');
}

async function loadData() {
  const res = await fetch('data/places.json');
  if (!res.ok) throw new Error('places.json 載入失敗');
  return res.json();
}

// ── 地圖 ────────────────────────────────
function setupMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
  }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // 免費且美觀的 tile：CartoDB Voyager（英文底圖，適合海島）
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CartoDB',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // 群聚圖層
  cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    maxClusterRadius: 45,
    disableClusteringAtZoom: 17,
    iconCreateFunction: (c) => {
      return L.divIcon({
        html: `<div>${c.getChildCount()}</div>`,
        className: 'marker-cluster-custom',
        iconSize: L.point(44, 44),
      });
    },
  });
  map.addLayer(cluster);
}

// ── 分類按鈕 ────────────────────────────
function renderCategories(categories) {
  const bar = document.getElementById('categoryBar');

  // 先重繪「全部」按鈕（原本是 emoji，改 SVG）
  const allBtn = bar.querySelector('[data-category="__all__"]');
  allBtn.style.setProperty('--cat-color', PRIMARY_COLOR);
  allBtn.innerHTML = `
    <span class="cat-icon">${svg(ALL_ICON)}</span>
    <span class="cat-label">全部</span>
  `;
  allBtn.addEventListener('click', () => setFilter('__all__'));

  categories.forEach((cat) => {
    const meta = CATEGORY_META[cat.name] || { icon: 'globe', color: '#9E8672' };
    const btn = document.createElement('button');
    btn.className = 'cat-btn';
    btn.dataset.category = cat.name;
    btn.style.setProperty('--cat-color', meta.color);
    btn.innerHTML = `
      <span class="cat-icon">${svg(meta.icon)}</span>
      <span class="cat-label">${escapeHtml(cat.name)}</span>
    `;
    btn.addEventListener('click', () => setFilter(cat.name));
    bar.appendChild(btn);
  });
}

function setFilter(category) {
  // 如果已經選中同一個分類（且不是「全部」）→ 切換清單開合
  if (category !== '__all__' && currentFilter === category) {
    const panel = document.getElementById('listPanel');
    if (panel.getAttribute('data-open') === 'true') {
      closeList();
    } else {
      openList(category);
    }
    return;
  }

  currentFilter = category;

  // 更新按鈕狀態
  document.querySelectorAll('.cat-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.category === category);
  });

  // 重建群聚：先清空，再加入符合的 markers
  cluster.clearLayers();
  const visible = allPlaces.filter(
    ({ category: c }) => category === '__all__' || c === category
  );
  cluster.addLayers(visible.map((p) => p.marker));

  // 依分類縮放
  if (visible.length > 0) {
    const bounds = L.latLngBounds(visible.map((p) => [p.place.lat, p.place.lng]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }

  closeSheet();
  closeSearchResults();

  // 全部：關閉清單；特定分類：打開清單
  if (category === '__all__') {
    closeList();
  } else {
    openList(category);
  }
}

// ── 分類清單面板 ─────────────────────────
function openList(category) {
  const meta = CATEGORY_META[category] || { icon: 'globe', color: '#9E8672' };
  const places = allPlaces.filter((p) => p.category === category);

  const panel = document.getElementById('listPanel');
  panel.style.setProperty('--cat-color', meta.color);
  document.getElementById('listHeadIcon').innerHTML = svg(meta.icon);
  document.getElementById('listTitle').textContent = category;
  document.getElementById('listCount').textContent = `${places.length} 個`;

  const ul = document.getElementById('listItems');
  ul.innerHTML = places
    .map(({ place, isWarn }, idx) => {
      const pinColor = isWarn ? WARN_PIN_COLOR : meta.color;
      const desc = (place.description || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .slice(0, 80);
      return `
        <li data-idx="${idx}">
          <span class="li-icon" style="background:${pinColor}">${svg(meta.icon)}</span>
          <div class="li-body">
            <div class="li-name">${escapeHtml(place.name)}${isWarn ? '<span class="warn-badge">踩雷</span>' : ''}</div>
            <div class="li-desc">${escapeHtml(desc)}</div>
          </div>
        </li>
      `;
    })
    .join('');

  ul.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      const item = places[parseInt(li.dataset.idx, 10)];
      closeList();
      setTimeout(() => {
        // 用 cluster API 確保 marker 真的在畫面上（如果還在群聚裡會自動展開）
        cluster.zoomToShowLayer(item.marker, () => {
          openSheet(item.place, category, item.isWarn, item.marker);
        });
      }, 280);
    });
  });

  panel.removeAttribute('hidden');
  requestAnimationFrame(() =>
    requestAnimationFrame(() => panel.setAttribute('data-open', 'true'))
  );
}

function closeList() {
  const panel = document.getElementById('listPanel');
  if (!panel) return;
  panel.setAttribute('data-open', 'false');
  setTimeout(() => panel.setAttribute('hidden', ''), 300);
}

// ── Marker ──────────────────────────────
function renderMarkers(categories) {
  categories.forEach((cat) => {
    const meta = CATEGORY_META[cat.name] || { icon: 'globe', color: '#9E8672' };
    cat.places.forEach((place) => {
      const isWarn = isWarnPlace(place);
      const pinColor = isWarn ? WARN_PIN_COLOR : meta.color;
      const marker = L.marker([place.lat, place.lng], {
        icon: buildIcon(meta.icon, pinColor, isWarn),
        title: place.name,
      });

      marker.on('click', () => openSheet(place, cat.name, isWarn, marker));
      cluster.addLayer(marker);
      allPlaces.push({ place, category: cat.name, marker, isWarn });
    });
  });
}

function buildIcon(iconName, color, isWarn) {
  return L.divIcon({
    className: '',
    html: `<div class="pin ${isWarn ? 'warn' : ''}" style="background:${color}">${svg(iconName)}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -17],
  });
}

// 將指定 marker 標為高亮（其他取消）。傳 null 表示全部取消。
function setActivePin(marker) {
  document.querySelectorAll('.pin.active').forEach((el) => el.classList.remove('active'));
  if (!marker) return;
  const el = marker.getElement();
  if (!el) return;
  const pin = el.querySelector('.pin');
  if (pin) pin.classList.add('active');
}

// ── 詳情面板 ────────────────────────────
function openSheet(place, category, isWarn, marker) {
  const sheet = document.getElementById('detailSheet');
  document.getElementById('sheetName').innerHTML =
    escapeHtml(place.name) + (isWarn ? '<span class="warn-badge">踩雷</span>' : '');
  const catMeta = CATEGORY_META[category] || { icon: 'globe', color: '#64748B' };
  document.getElementById('sheetCategory').innerHTML =
    `<span class="sheet-cat-icon" style="background:${catMeta.color}">${svg(catMeta.icon)}</span>${escapeHtml(category)}`;
  const descEl = document.getElementById('sheetDesc');
  // 允許 <br> 和基本 HTML（來源是可信的 KML）
  descEl.innerHTML = place.description || '';

  const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  document.getElementById('sheetNav').href = navUrl;

  document.getElementById('sheetCopy').onclick = () => {
    navigator.clipboard.writeText(`${place.lat}, ${place.lng}`);
    const btn = document.getElementById('sheetCopy');
    const orig = btn.textContent;
    btn.textContent = '已複製 ✓';
    setTimeout(() => (btn.textContent = orig), 1500);
  };

  sheet.removeAttribute('hidden');
  requestAnimationFrame(() => sheet.setAttribute('data-open', 'true'));

  // 地圖微調：讓 marker 不被面板蓋住
  map.panTo([place.lat, place.lng], { animate: true });
  activeMarker = { place, category, marker };
  // 高亮選中的 pin（等 panTo 結束再標，避免被群聚動畫覆蓋）
  setTimeout(() => setActivePin(marker), 200);
}

function closeSheet() {
  const sheet = document.getElementById('detailSheet');
  sheet.setAttribute('data-open', 'false');
  setTimeout(() => sheet.setAttribute('hidden', ''), 300);
  activeMarker = null;
  setActivePin(null);
}

function setupSheetClose() {
  document.getElementById('sheetClose').addEventListener('click', closeSheet);

  // 事件委派：綁在穩定的 panel 上，不受內容替換影響
  const listPanel = document.getElementById('listPanel');
  const handleListClose = (e) => {
    if (e.target.closest('#listClose') || e.target.closest('.sheet-handle')) {
      e.preventDefault();
      closeList();
    }
  };
  listPanel.addEventListener('click', handleListClose);
  listPanel.addEventListener('touchend', handleListClose);

  map.on('click', () => { closeSheet(); closeList(); });
}

// ── 關於彈窗 ────────────────────────────
function setupInfoModal(data) {
  const modal = document.getElementById('infoModal');
  const metaEl = document.getElementById('infoMeta');

  const d = new Date(data.updatedAt);
  metaEl.textContent = `共 ${data.totalPlaces} 個地標 · 最後更新 ${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

  document.getElementById('infoBtn').addEventListener('click', () => modal.removeAttribute('hidden'));
  document.getElementById('infoClose').addEventListener('click', () => modal.setAttribute('hidden', ''));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.setAttribute('hidden', '');
  });
}

// ── 搜尋 ────────────────────────────────
function setupSearch() {
  const btn = document.getElementById('searchBtn');
  const wrap = document.getElementById('searchWrap');
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');
  const results = document.getElementById('searchResults');

  function openSearch() {
    wrap.removeAttribute('hidden');
    btn.classList.add('active');
    document.documentElement.style.setProperty('--topbar-ext', '60px');
    setTimeout(() => {
      input.focus();
      // 通知 Leaflet 重算尺寸
      if (map) map.invalidateSize();
    }, 50);
  }
  function closeSearch() {
    wrap.setAttribute('hidden', '');
    btn.classList.remove('active');
    document.documentElement.style.setProperty('--topbar-ext', '0px');
    input.value = '';
    clearBtn.classList.remove('show');
    closeSearchResults();
    setTimeout(() => { if (map) map.invalidateSize(); }, 50);
  }

  btn.addEventListener('click', () => {
    if (wrap.hasAttribute('hidden')) openSearch();
    else closeSearch();
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.remove('show');
    closeSearchResults();
    input.focus();
  });
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    clearBtn.classList.toggle('show', q.length > 0);
    if (q.length === 0) {
      closeSearchResults();
      return;
    }
    const matches = allPlaces
      .filter(({ place, category }) =>
        place.name.toLowerCase().includes(q) ||
        category.toLowerCase().includes(q)
      )
      .slice(0, 12);
    renderSearchResults(matches, q);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
  });

  // 點 results 外面關閉
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closeSearchResults();
    }
  });
}

function renderSearchResults(matches, q) {
  const results = document.getElementById('searchResults');
  results.innerHTML = '';
  if (matches.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `找不到「${q}」的相關地標`;
    results.appendChild(li);
  } else {
    matches.forEach(({ place, category, marker, isWarn }) => {
      const meta = CATEGORY_META[category] || { icon: 'globe', color: '#9E8672' };
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="r-icon" style="background:${isWarn ? WARN_PIN_COLOR : meta.color}">${svg(meta.icon)}</span>
        <span class="r-name">${escapeHtml(place.name)}</span>
        <span class="r-cat">${escapeHtml(category)}</span>
      `;
      li.addEventListener('click', () => {
        closeSearchResults();
        // 如果目前過濾器不包含這個 category，先切回「全部」
        if (currentFilter !== '__all__' && currentFilter !== category) {
          setFilter('__all__');
        }
        // 稍等 cluster rebuild 再導航 + 開詳情
        setTimeout(() => {
          map.setView([place.lat, place.lng], 17);
          openSheet(place, category, isWarn);
        }, 80);
      });
      results.appendChild(li);
    });
  }
  results.removeAttribute('hidden');
}

function closeSearchResults() {
  const results = document.getElementById('searchResults');
  results.setAttribute('hidden', '');
  results.innerHTML = '';
}

function fitToAll() {
  if (allPlaces.length === 0) return;
  const bounds = L.latLngBounds(allPlaces.map((p) => [p.place.lat, p.place.lng]));
  map.fitBounds(bounds, { padding: [40, 40] });
}

// ── 工具 ────────────────────────────────
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// 啟動
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
