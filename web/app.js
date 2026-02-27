const DATA_URL = "./data/places.json";
const YOUTUBE_GATSUO_URL = "https://youtu.be/eOuRDr4EpRE?si=3Qp_mUndCnQEJLZk&t=429";
const YOUTUBE_GATSUO_PATTERN = /\uAC00\uC4F0\uC624\s*\uACF5\uC0AC/i;
const EPISODE_COLORS = new Map([
  [1, "#D96B2B"],
  [2, "#6E4FB8"],
  [3, "#2F8CFF"],
  [4, "#E7C97A"],
  [5, "#C93B3B"],
]);

const YOUTUBE_TIMESTAMP_OVERRIDES = new Map([
  [
    "가쓰오 공사",
    {
      url: "https://youtu.be/eOuRDr4EpRE?si=3Qp_mUndCnQEJLZk&t=429",
      startSeconds: 429,
    },
  ],
]);
const MOBILE_BREAKPOINT = 980;

const els = {
  app: document.querySelector(".app"),
  sidebar: document.getElementById("sidebar"),
  loader: document.getElementById("loader"),
  errorBox: document.getElementById("errorBox"),
  folderChips: document.getElementById("folderChips"),
  placeList: document.getElementById("placeList"),
  resultCount: document.getElementById("resultCount"),
  statusLine: document.getElementById("statusLine"),
  searchInput: document.getElementById("searchInput"),
  btnSheetToggle: document.getElementById("btnSheetToggle"),
};

/** @typedef {{id:string, category:string, name:string, description:string, lat:number, lon:number, youtubeUrl:string|null, youtubeId:string|null, youtubeStart:number|null, youtubeStartLabel:string|null, youtubeFrameImage:string|null, youtubeFrame:{url:string|null, x:number|null, y:number|null, width:number|null, height:number|null}|null}} Place */
const state = {
  map: null,
  markerLayer: null,
  markersById: new Map(),
  places: /** @type {Place[]} */ ([]),
  categories: /** @type {string[]} */ ([]),
  categoryCounts: new Map(),
  categoryEnabled: new Set(),
  activeId: null,
  query: "",
  labelCollisionRaf: null,
};

function init() {
  wireEvents();
  syncMobileSheetMode();
  initMap();
  loadData().catch((error) => {
    console.error(error);
    showError();
  });
}

function wireEvents() {
  els.searchInput.addEventListener("input", () => {
    state.query = els.searchInput.value.trim().toLowerCase();
    renderAll();
  });

  els.btnSheetToggle?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMobileSheet();
  });

  els.searchInput.addEventListener("focus", () => {
    if (isMobileViewport()) {
      setMobileSheetState(true);
    }
  });

  els.sidebar?.addEventListener("focusin", (event) => {
    if (!isMobileViewport()) return;
    const target = event.target;
    if (target instanceof Node && els.btnSheetToggle?.contains(target)) return;
    setMobileSheetState(true);
  });

  window.addEventListener("resize", () => {
    syncMobileSheetMode();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isMobileViewport()) {
      setMobileSheetState(false);
    }
    if (event.key === "/" && document.activeElement !== els.searchInput) {
      event.preventDefault();
      els.searchInput.focus();
      if (isMobileViewport()) {
        setMobileSheetState(true);
      }
    }
  });
}

function isMobileViewport() {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

function syncMobileSheetMode() {
  if (!els.app) return;

  if (isMobileViewport()) {
    if (els.app.dataset.sheet !== "expanded") {
      els.app.dataset.sheet = "collapsed";
    }
    updateSheetToggleState();
    return;
  }

  els.app.dataset.sheet = "desktop";
  updateSheetToggleState();
}

function toggleMobileSheet() {
  if (!els.app || !isMobileViewport()) return;
  const expanded = els.app.dataset.sheet === "expanded";
  setMobileSheetState(!expanded);
}

function setMobileSheetState(expanded) {
  if (!els.app || !isMobileViewport()) return;
  els.app.dataset.sheet = expanded ? "expanded" : "collapsed";
  updateSheetToggleState();
}

function updateSheetToggleState() {
  if (!els.btnSheetToggle || !els.app) return;
  const expanded = !isMobileViewport() || els.app.dataset.sheet === "expanded";
  els.btnSheetToggle.setAttribute("aria-expanded", String(expanded));
}

function initMap() {
  const map = L.map("map", { zoomControl: true, preferCanvas: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a>',
  }).addTo(map);
  state.map = map;
  state.markerLayer = L.layerGroup().addTo(map);
  map.on("moveend zoomend resize", scheduleLabelCollisionUpdate);
  map.on("click", () => {
    if (isMobileViewport()) {
      setMobileSheetState(false);
    }
  });
  map.setView([35.2, 129.1], 5);
}

async function loadData() {
  setStatus("places.json 로딩 중...");
  showLoader(true);

  const resp = await fetch(DATA_URL, { cache: "no-store" });
  if (!resp.ok) throw new Error(`places.json fetch failed: ${resp.status}`);
  const rawPlaces = (await resp.json()) ?? [];
  const places = rawPlaces.map((place) => normalizePlace(place));

  const countByCategory = new Map();
  for (const place of places) {
    countByCategory.set(place.category, (countByCategory.get(place.category) ?? 0) + 1);
  }

  state.places = places;
  state.categories = Array.from(countByCategory.keys()).sort();
  state.categoryEnabled = new Set(state.categories);
  state.categoryCounts = countByCategory;

  buildMarkers();
  renderCategoryChips();
  renderAll();
  fitToVisible();
  showLoader(false);
  setStatus(`${places.length}개 장소 로드 완료`);
}

function buildMarkers() {
  state.markersById.clear();
  state.markerLayer.clearLayers();

  for (const place of state.places) {
    const color = categoryColor(place.category);
    const marker = L.marker([place.lat, place.lon], {
      icon: createPlaceMarkerIcon(place, color),
      keyboard: true,
      title: place.name,
    });

    marker.bindPopup(renderPopupHtml(place), { autoPanPadding: [24, 24], closeButton: false });
    marker.on("click", () => {
      state.activeId = place.id;
      renderList();
      setStatus(`${place.category} · ${place.name}`);
    });
    state.markersById.set(place.id, marker);
  }
}

function createPlaceMarkerIcon(place, color) {
  const html = `
    <div class="mapMarker" style="--marker:${color}">
      <span class="mapMarker__label">${escapeHtml(place.name)}</span>
      <span class="mapMarker__pin" aria-hidden="true"></span>
    </div>
  `;

  return L.divIcon({
    className: "mapMarkerIcon",
    html,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    popupAnchor: [0, -52],
  });
}

function renderCategoryChips() {
  const chips = [];
  for (const category of state.categories) {
    const count = state.categoryCounts.get(category) ?? 0;
    chips.push(
      categoryChipHtml({
        id: category,
        label: category,
        count,
        pressed: true,
        swatch: categoryColor(category),
      }),
    );
  }

  els.folderChips.innerHTML = chips.join("");
  els.folderChips.addEventListener("click", (event) => {
    const target = /** @type {HTMLElement | null} */ (event.target.closest("[data-chip]"));
    if (!target) return;

    const category = target.dataset.chip;
    if (!category) return;

    if (state.categoryEnabled.has(category)) state.categoryEnabled.delete(category);
    else state.categoryEnabled.add(category);

    syncChipState();
    renderAll();
    fitToVisible();
  });
}

function syncChipState() {
  for (const category of state.categories) {
    const selector = `[data-chip="${cssSafe(category)}"]`;
    const chip = els.folderChips.querySelector(selector);
    if (chip) chip.setAttribute("aria-pressed", String(state.categoryEnabled.has(category)));
  }
}

function normalizeCategory(rawCategory) {
  const category = String(rawCategory ?? "").trim();
  if (!category) {
    return "기타";
  }
  return category.replace(/^\s*식덕후\s*지도\s*쨌\s*/u, "").trim();
}

function normalizeCategorySafe(rawCategory) {
  const normalized = normalizeCategory(rawCategory);
  if (typeof normalized !== "string") {
    return "카테고리 없음";
  }

  if (normalized.startsWith("식덕후 지도")) {
    return normalized.replace(/^식덕후\s*지도\s*/u, "").trim();
  }
  if (normalized.startsWith("식덕후 ")) {
    return normalized.replace(/^식덕후\s*/u, "").trim();
  }

  return normalized;
}

function renderAll() {
  renderMarkers();
  renderList();
  renderCounts();
}

function renderMarkers() {
  state.markerLayer.clearLayers();
  for (const place of getVisiblePlaces()) {
    const marker = state.markersById.get(place.id);
    if (marker) marker.addTo(state.markerLayer);
  }
  scheduleLabelCollisionUpdate();
}

function scheduleLabelCollisionUpdate() {
  if (!state.map) return;
  if (state.labelCollisionRaf != null) {
    cancelAnimationFrame(state.labelCollisionRaf);
  }

  state.labelCollisionRaf = requestAnimationFrame(() => {
    state.labelCollisionRaf = null;
    applyLabelCollisionVisibility();
  });
}

function applyLabelCollisionVisibility() {
  const keptRects = [];
  for (const place of getVisiblePlaces()) {
    const marker = state.markersById.get(place.id);
    const markerRoot = marker?.getElement();
    const markerBody = markerRoot?.querySelector(".mapMarker");
    const label = markerRoot?.querySelector(".mapMarker__label");

    if (!(markerBody instanceof HTMLElement) || !(label instanceof HTMLElement)) {
      continue;
    }

    markerBody.classList.remove("mapMarker--labelHidden");
    const rect = label.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const overlapped = keptRects.some((existingRect) => rectIntersects(rect, existingRect, 4));
    if (overlapped) {
      markerBody.classList.add("mapMarker--labelHidden");
      continue;
    }

    keptRects.push(rect);
  }
}

function rectIntersects(left, right, padding = 0) {
  return !(
    left.right + padding <= right.left ||
    left.left >= right.right + padding ||
    left.bottom + padding <= right.top ||
    left.top >= right.bottom + padding
  );
}

function renderList() {
  const visible = getVisiblePlaces();
  els.placeList.innerHTML = visible.map((place) => placeItemHtml(place)).join("") || emptyListHtml();

  for (const row of els.placeList.querySelectorAll("[data-place-id]")) {
    row.addEventListener("click", () => {
      const id = /** @type {HTMLElement} */ (row).dataset.placeId;
      if (!id) return;
      const place = state.places.find((item) => item.id === id);
      const marker = place ? state.markersById.get(id) : null;
      if (!place || !marker) return;

      state.activeId = id;
      renderList();
      if (isMobileViewport()) {
        setMobileSheetState(false);
      }
      state.map.flyTo([place.lat, place.lon], Math.max(state.map.getZoom(), 12), { duration: 0.6 });
      marker.openPopup();
    });
  }
}

function renderCounts() {
  const visible = getVisiblePlaces();
  els.resultCount.textContent = `${visible.length} / ${state.places.length}`;
}

function fitToVisible() {
  const visible = getVisiblePlaces();
  if (!visible.length) return;
  const bounds = L.latLngBounds(visible.map((place) => [place.lat, place.lon]));
  state.map.fitBounds(bounds.pad(0.2), { animate: true, duration: 0.6, maxZoom: 13 });
}

function getVisiblePlaces() {
  const query = state.query;

  return state.places
    .filter((place) => state.categoryEnabled.has(place.category))
    .filter((place) => {
      if (!query) return true;
      const text = `${place.name} ${place.description} ${place.category}`.toLowerCase();
      return text.includes(query);
    })
    .sort((left, right) => {
      const episodeDiff = parseEpisodeFromCategory(left.category) - parseEpisodeFromCategory(right.category);
      if (episodeDiff !== 0) return episodeDiff;

      const leftStart = left.youtubeStart ?? Number.POSITIVE_INFINITY;
      const rightStart = right.youtubeStart ?? Number.POSITIVE_INFINITY;
      const startDiff = leftStart - rightStart;
      if (startDiff !== 0) return startDiff;

      return left.name.localeCompare(right.name, "ko");
    });
}

function renderPopupHtml(place) {
  const link = youtubeLinkHtml(place);
  const image = youtubeThumbHtml(place);
  const showMetaText = !place.youtubeUrl;
  const timestamp = showMetaText && place.youtubeStartLabel
    ? `<div class="popup__timestamp">타임스탬프: ${place.youtubeStartLabel}</div>`
    : "";
  const description = showMetaText ? escapeHtml(place.description || "설명 없음") : "";
  const coords = `${place.lat.toFixed(6)}, ${place.lon.toFixed(6)}`;

  return `
    <div class="popupTitle">${escapeHtml(place.name)}</div>
    <div class="popupMeta">${escapeHtml(place.category)} · ${coords}</div>
    ${showMetaText ? `<div class="popup__desc">${description}</div>` : ""}
    ${timestamp}
    ${image}
    <div class="popupActions">
      ${link}
      <a class="pillLink pillLink--alt" href="https://www.google.com/maps?q=${encodeURIComponent(`${place.lat},${place.lon}`)}" target="_blank" rel="noreferrer noopener">Google Maps 열기</a>
    </div>
  `;
}

function placeItemHtml(place) {
  const active = place.id === state.activeId ? "is-active" : "";

  return `
    <button class="place ${active}" type="button" role="listitem" data-place-id="${escapeHtml(place.id)}">
      <div class="place__bullet" style="--dot:${categoryColor(place.category)}"></div>
      <div>
        <div class="place__name">${escapeHtml(place.name)}</div>
        <div class="place__meta">
          <span class="tag">
            <span class="tag__swatch" style="background:${categoryColor(place.category)}"></span>${escapeHtml(place.category)}
          </span>
        </div>
      </div>
    </button>
  `;
}

function youtubeLinkHtml(place) {
  if (!place.youtubeUrl) {
    return "";
  }
  const href = youtubeWatchUrl(place);
  return `<a class="pillLink" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">유튜브 열기 ↗</a>`;
}

function youtubeWatchUrl(place) {
  if (!place.youtubeUrl) {
    return "";
  }

  try {
    const url = new URL(place.youtubeUrl);
    if (place.youtubeStart != null) {
      url.searchParams.set("t", `${place.youtubeStart}s`);
    }
    return url.toString();
  } catch (_error) {
    const separator = place.youtubeUrl.includes("?") ? "&" : "?";
    return `${place.youtubeUrl}${place.youtubeStart != null ? `${separator}t=${place.youtubeStart}s` : ""}`;
  }
}

function normalizePlace(place) {
  const normalized = {
    ...place,
    category: normalizeCategorySafe(place.category),
  };
  return normalizeYoutubeFallback(normalized);
}

function normalizeYoutubeFallback(place) {
  const placeName = (place.name ?? "").trim();
  const entry =
    YOUTUBE_TIMESTAMP_OVERRIDES.get(placeName) ??
    (YOUTUBE_GATSUO_PATTERN.test(placeName)
      ? { url: YOUTUBE_GATSUO_URL, startSeconds: 429 }
      : null);
  if (!entry) {
    return place;
  }

  const updated = { ...place };
  if (entry.url) {
    updated.youtubeUrl = entry.url;
  }
  if (entry.startSeconds > 0) {
    updated.youtubeStart = entry.startSeconds;
    updated.youtubeStartLabel = secondsToLabel(entry.startSeconds);
  }

  return updated;
}

function parseEpisode(category) {
  if (!category) return Number.POSITIVE_INFINITY;

  const match = String(category).match(/ep\.?\s*(\d+(?:\.\d+)?)/i);
  if (match?.[1]) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  const koreaMatch = String(category).match(/에피소드\s*(\d+(?:\.\d+)?)/i);
  if (koreaMatch?.[1]) {
    const parsed = Number(koreaMatch[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  return Number.POSITIVE_INFINITY;
}

function parseEpisodeFromCategory(category) {
  if (!category) return Number.POSITIVE_INFINITY;
  const normalized = String(category).toLowerCase();
  const match = normalized.match(/ep\.?\s*(\d+(?:\.\d+)?)/i);
  if (!match?.[1]) return Number.POSITIVE_INFINITY;

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function secondsToLabel(seconds) {
  const totalSeconds = Number(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function youtubeThumbUrl(place) {
  if (!place.youtubeId) return "";
  return `https://i.ytimg.com/vi/${encodeURIComponent(place.youtubeId)}/maxresdefault.jpg`;
}

function youtubeThumbFallbackUrl(place) {
  if (!place.youtubeId) return "";
  return `https://i.ytimg.com/vi/${encodeURIComponent(place.youtubeId)}/hqdefault.jpg`;
}

function youtubeThumbSecondaryFallbackUrl(place) {
  if (!place.youtubeId) return "";
  return `https://i.ytimg.com/vi/${encodeURIComponent(place.youtubeId)}/mqdefault.jpg`;
}

function youtubeThumbHtml(place) {
  const frameUrl = String(place.youtubeFrameImage || "").trim();
  const thumbnailUrl = youtubeThumbUrl(place);
  const fallbackUrl = youtubeThumbFallbackUrl(place);
  const secondaryFallbackUrl = youtubeThumbSecondaryFallbackUrl(place);
  const primaryUrl = frameUrl || thumbnailUrl;

  if (!primaryUrl) return "";

  const escapedFallback = escapeHtml(fallbackUrl);
  const escapedSecondaryFallback = escapeHtml(secondaryFallbackUrl);
  const onErrorScript = secondaryFallbackUrl
    ? `if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${escapedFallback}';return;}if(this.dataset.fb!=='2'){this.dataset.fb='2';this.src='${escapedSecondaryFallback}';return;}this.onerror=null;`
    : `if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${escapedFallback}';return;}this.onerror=null;`;

  return `<img class="popup__thumb popup__thumb--video" src="${escapeHtml(primaryUrl)}" alt="${escapeHtml(`${place.name} video screenshot`)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="${onErrorScript}">`;
}

function emptyListHtml() {
  return `<div style="padding:14px 10px;color:var(--muted);font-size:13px;">검색 결과가 없습니다. 다른 키워드로 다시 시도하세요.</div>`;
}

function categoryChipHtml({ id, label, count, pressed, swatch }) {
  return `
    <button class="chip" type="button" data-chip="${escapeHtml(id)}" aria-pressed="${String(pressed)}">
      <span class="chip__dot" style="background:${swatch}"></span>
      <span class="chip__text">${escapeHtml(label)}</span>
      <span class="chip__count">${count}</span>
    </button>
  `;
}

function categoryColor(category) {
  const episode = parseEpisodeFromCategory(category);
  if (Number.isFinite(episode)) {
    const key = Math.trunc(episode);
    const mapped = EPISODE_COLORS.get(key);
    if (mapped) return mapped;
  }
  const hash = hashCode(category);
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 98%, 55%)`;
}

function hashCode(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function showLoader(on) {
  els.loader.classList.toggle("is-hidden", !on);
  els.errorBox.classList.add("is-hidden");
}

function showError() {
  showLoader(false);
  els.errorBox.classList.remove("is-hidden");
  setStatus("에러 발생");
}

function setStatus(text) {
  if (els.statusLine) {
    els.statusLine.textContent = text;
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function cssSafe(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

init();
