const DATA_URL = "./data/places.json";

const els = {
  app: document.querySelector(".app"),
  loader: document.getElementById("loader"),
  errorBox: document.getElementById("errorBox"),
  folderChips: document.getElementById("folderChips"),
  placeList: document.getElementById("placeList"),
  resultCount: document.getElementById("resultCount"),
  statusLine: document.getElementById("statusLine"),
  searchInput: document.getElementById("searchInput"),
  btnReset: document.getElementById("btnReset"),
  btnSidebar: document.getElementById("btnSidebar"),
};

/** @typedef {{id:string, category:string, name:string, description:string, lat:number, lon:number, youtubeUrl:string|null, youtubeId:string|null, youtubeStart:number|null, youtubeStartLabel:string|null}} Place */
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
};

function init() {
  wireEvents();
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

  els.btnReset.addEventListener("click", () => {
    state.query = "";
    state.activeId = null;
    state.categoryEnabled = new Set(state.categories);
    els.searchInput.value = "";
    syncChipState();
    renderAll();
    fitToVisible();
    setStatus("초기화");
  });

  els.btnSidebar.addEventListener("click", () => {
    const open = els.app.dataset.sidebar !== "closed";
    els.app.dataset.sidebar = open ? "closed" : "open";
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      els.app.dataset.sidebar = "closed";
    }
    if (event.key === "/" && document.activeElement !== els.searchInput) {
      event.preventDefault();
      els.searchInput.focus();
    }
  });
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
  map.setView([35.2, 129.1], 5);
}

async function loadData() {
  setStatus("places.json 로딩 중...");
  showLoader(true);

  const resp = await fetch(DATA_URL, { cache: "no-store" });
  if (!resp.ok) throw new Error(`places.json fetch failed: ${resp.status}`);
  const places = (await resp.json()) ?? [];

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
    const marker = L.circleMarker([place.lat, place.lon], {
      radius: 8,
      weight: 3,
      color,
      fillColor: color,
      fillOpacity: 1,
      opacity: 1,
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

function renderCategoryChips() {
  const chips = [
    categoryChipHtml({ id: "__all__", label: "전체", count: state.places.length, pressed: true, swatch: "#2c7a4b" }),
  ];
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

    if (category === "__all__") {
      const allEnabled = state.categoryEnabled.size === state.categories.length;
      state.categoryEnabled = allEnabled ? new Set() : new Set(state.categories);
    } else {
      if (state.categoryEnabled.has(category)) state.categoryEnabled.delete(category);
      else state.categoryEnabled.add(category);
    }

    syncChipState();
    renderAll();
    fitToVisible();
  });
}

function syncChipState() {
  const allActive = state.categoryEnabled.size === state.categories.length;
  els.folderChips.querySelector('[data-chip="__all__"]')?.setAttribute("aria-pressed", String(allActive));

  for (const category of state.categories) {
    const selector = `[data-chip="${cssSafe(category)}"]`;
    const chip = els.folderChips.querySelector(selector);
    if (chip) chip.setAttribute("aria-pressed", String(state.categoryEnabled.has(category)));
  }
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
      els.app.dataset.sidebar = "closed";
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
  return state.places
    .filter((place) => state.categoryEnabled.has(place.category))
    .filter((place) => {
      if (!state.query) return true;
      const text = `${place.name} ${place.description} ${place.category}`.toLowerCase();
      return text.includes(state.query);
    });
}

function renderPopupHtml(place) {
  const link = youtubeLinkHtml(place);
  const timestamp = place.youtubeStartLabel
    ? `<div class="popup__timestamp">타임스탬프: ${place.youtubeStartLabel}</div>`
    : "";
  const description = escapeHtml(place.description || "설명 없음");
  const coords = `${place.lat.toFixed(6)}, ${place.lon.toFixed(6)}`;

  return `
    <div class="popupTitle">${escapeHtml(place.name)}</div>
    <div class="popupMeta">${escapeHtml(place.category)} · ${coords}</div>
    <div class="popup__desc">${description}</div>
    ${timestamp}
    <div class="popupActions">
      ${link}
      <a class="pillLink pillLink--alt" href="https://www.google.com/maps?q=${encodeURIComponent(`${place.lat},${place.lon}`)}" target="_blank" rel="noreferrer noopener">Google Maps 열기</a>
    </div>
  `;
}

function placeItemHtml(place) {
  const active = place.id === state.activeId ? "is-active" : "";
  const timeTag = place.youtubeStartLabel ? `<span class="tag">timestamp ${place.youtubeStartLabel}</span>` : "";

  return `
    <button class="place ${active}" type="button" role="listitem" data-place-id="${escapeHtml(place.id)}">
      <div class="place__bullet" style="--dot:${categoryColor(place.category)}"></div>
      <div>
        <div class="place__name">${escapeHtml(place.name)}</div>
        <div class="place__meta">
          <span class="tag">
            <span class="tag__swatch" style="background:${categoryColor(place.category)}"></span>${escapeHtml(place.category)}
          </span>
          ${timeTag}
        </div>
      </div>
    </button>
  `;
}

function youtubeLinkHtml(place) {
  if (!place.youtubeUrl) {
    return "";
  }
  const label = place.youtubeStartLabel ? ` (${place.youtubeStartLabel})` : "";
  const href = youtubeWatchUrl(place);
  return `<a class="pillLink" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">유튜브${label} 열기 ↗</a>`;
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
  const hash = hashCode(category);
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 86%, 40%)`;
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
  els.statusLine.textContent = text;
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
