// ────────────────────────────────────────────────────────────────
// 네이버 지도 + 마라톤 코스 오버레이
// ────────────────────────────────────────────────────────────────

// 🔑 네이버 클라우드 플랫폼에서 발급받은 Maps 키로 교체하세요.
//    https://console.ncloud.com → AI·NAVER API / Maps → 인증 정보(Client ID)
//    그리고 [Web 서비스 URL]에 이 페이지 도메인(예: http://localhost:5500)을 등록.
//    ※ 신규 콘솔 키는 ncpKeyId, 구버전 키는 ncpClientId 파라미터를 씁니다.
const NAVER_CLIENT_ID = "22szac44wv";

// 네이버 SDK를 동적으로 로드 (키 교체만 하면 되도록)
function loadNaverSdk() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=" +
      NAVER_CLIENT_ID +
      "&submodules=panorama";
    script.onload = () => {
      if (window.naver && window.naver.maps) {
        resolve();
      } else {
        reject(new Error("naver 객체 없음"));
      }
    };
    script.onerror = () => reject(new Error("SDK 로드 실패"));
    document.head.appendChild(script);
  });
}

function showFallback() {
  document.getElementById("map").style.display = "none";
  document.getElementById("map-fallback").hidden = false;
}

// 정규화된 대회 목록 (initMap 등에서 사용)
//   각 대회: { id, name, date, place, fee, url, variants:[{vid, distance, color, start, path}] }
let EVENTS = [];

// 거리 문자열 → 숫자(km) 목록. "풀"=42.195, "하프"=21.1, "10km"=10 ...
function parseDistancesKm(str) {
  const out = [];
  const s = String(str || "");
  if (/풀/.test(s)) out.push(42.195);
  if (/하프/.test(s)) out.push(21.1);
  const re = /(\d+(?:\.\d+)?)\s*km/gi;
  let m;
  while ((m = re.exec(s))) out.push(parseFloat(m[1]));
  return out;
}
// 참가비 문자열 → 최소 금액(원). "무료"=0, 숫자 없으면 null
function parseFeeMin(str) {
  const s = String(str || "");
  if (/무료/.test(s)) return 0;
  const re = /([\d,]+)\s*원/g;
  let m, min = null;
  while ((m = re.exec(s))) {
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    if (Number.isFinite(n)) min = min === null ? n : Math.min(min, n);
  }
  return min;
}

// 코스 위 지점(waypoint) 타입 — admin.js/server.js와 키 일치
const WP_TYPES = {
  start: { ko: "출발", color: "#16a34a" },
  finish: { ko: "도착", color: "#0ea5e9" },
  turn: { ko: "반환점", color: "#E8413A" },
  water: { ko: "급수대", color: "#2563eb" },
  km: { ko: "km", color: "#f59e0b" },
  etc: { ko: "지점", color: "#6b7280" },
};
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// 지점 핀 HTML (라벨 알약 + 점). 점 중심이 좌표에 앵커됨.
function wpPinHtml(wp) {
  const t = WP_TYPES[wp.type] || WP_TYPES.etc;
  const text = (wp.label || t.ko).trim();
  return (
    '<div class="wp-pin" style="--wp:' + t.color + '">' +
    '<span class="wp-pin__label">' + escHtml(text) + "</span>" +
    '<span class="wp-pin__dot"></span></div>'
  );
}
// 겹침 표시용 — variant 순번을 화면 px 오프셋으로(0, +g, -g, +2g, -2g 순환, 최대 ±6px)
function rankToPx(i) {
  const g = 3.5;
  const k = i % 5;            // 0..4
  const step = Math.ceil(k / 2);   // 0,1,1,2,2
  const sign = k % 2 === 1 ? 1 : -1;
  return step * g * sign;
}
// 경로 점들 중 target([lat,lng])에 가장 가까운 인덱스 (마커를 오프셋 선에 맞출 때)
function nearestIdx(geoPath, target) {
  let best = 0, bestD = Infinity;
  for (let j = 0; j < geoPath.length; j++) {
    const dla = geoPath[j][0] - target[0], dln = geoPath[j][1] - target[1];
    const d = dla * dla + dln * dln;
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}
// 경로를 진행방향의 수직으로 offsetPx 만큼 어긋나게 → 겹치는 코스가 나란히 보이게
function offsetPath(naver, geoPath, offsetPx, proj) {
  const pts = geoPath.map(([lat, lng]) => proj.fromCoordToOffset(new naver.maps.LatLng(lat, lng)));
  return pts.map((p, j) => {
    const a = pts[Math.max(0, j - 1)];
    const b = pts[Math.min(pts.length - 1, j + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return proj.fromOffsetToCoord(
      new naver.maps.Point(p.x + (-dy / len) * offsetPx, p.y + (dx / len) * offsetPx)
    );
  });
}

// 출발 마커 — 마라톤 배번호판. 색 밴드 + 거리 숫자. 점 중심이 좌표에 앵커됨.
function bibHtml(event, v) {
  const num = (v.distance || "START").trim();
  return (
    '<div class="bib-pin">' +
    '<div class="bib" style="--bib:' + v.color + '">' +
    '<span class="bib__top">출발</span>' +
    '<span class="bib__num">' + escHtml(num) + "</span>" +
    "</div>" +
    '<span class="bib-pin__dot" style="--bib:' + v.color + '"></span>' +
    "</div>"
  );
}
function normalizeWaypoints(w) {
  return (Array.isArray(w) ? w : [])
    .map((q) => ({
      type: q && WP_TYPES[q.type] ? q.type : "etc",
      label: (q && q.label) || "",
      lat: Number(q && q.lat),
      lng: Number(q && q.lng),
    }))
    .filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lng));
}

// 서버/data.js의 원본을 정규화. 구모델(평면 path/distance/color)도 variant 1개로 감싼다.
function normalizeEvents(list) {
  return (Array.isArray(list) ? list : []).map((e) => {
    const id = e.id || e.name || "event";
    const rawVariants = Array.isArray(e.variants)
      ? e.variants
      : [{ distance: e.distance, color: e.color, start: e.start, path: e.path }];
    const variants = rawVariants
      .map((v, i) => ({
        vid: id + "#" + i,
        distance: v.distance || "",
        color: /^#[0-9a-fA-F]{6}$/.test(v.color) ? v.color : "#E8413A",
        path: Array.isArray(v.path) ? v.path : [],
        start:
          Array.isArray(v.start) && v.start.length === 2
            ? v.start
            : (Array.isArray(v.path) && v.path[0]) || [37.54, 126.99],
        waypoints: normalizeWaypoints(v.waypoints),
      }))
      .filter((v) => v.path.length >= 2);
    const scaleNum = Number(e.scale);
    return {
      id,
      name: e.name || "",
      date: e.date || "",
      place: e.place || "",
      region: e.region || "",
      fee: e.fee || "",
      scale: Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : null,
      url: e.url || "#",
      variants,
      // 필터용 파생값
      distancesKm: [...new Set(variants.flatMap((v) => parseDistancesKm(v.distance)))],
      feeMin: parseFeeMin(e.fee),
    };
  });
}

// 지도 + 코스 그리기
function initMap() {
  const naver = window.naver;
  const container = document.getElementById("map");

  const map = new naver.maps.Map(container, {
    center: new naver.maps.LatLng(37.5400, 126.9900), // 서울 한강 부근
    zoom: 9,
    // 네이버 기본 컨트롤은 끄고 커스텀 UI로 통일 (setupMapControls)
    zoomControl: false,
    mapTypeControl: false,
  });

  // 거리별 코스(variant) 단위로 오버레이 저장
  const overlays = {}; // vid -> { polyline, marker, infowindow }
  const bounds = new naver.maps.LatLngBounds();
  let offsetSeq = 0; // 겹침 평행선용 순번

  EVENTS.forEach((event) => {
    event.variants.forEach((v) => {
      const linePath = v.path.map(
        ([lat, lng]) => new naver.maps.LatLng(lat, lng)
      );
      linePath.forEach((p) => bounds.extend(p));

      // 코스 폴리라인
      const polyline = new naver.maps.Polyline({
        path: linePath,
        strokeWeight: 5,
        strokeColor: v.color,
        strokeOpacity: 0.85,
        strokeStyle: "solid",
        strokeLineCap: "round",   // 끝을 둥글게
        strokeLineJoin: "round",  // 꼭짓점을 둥글게 → 각진 느낌 완화
        clickable: true,          // hover/click 이벤트 수신 (없으면 마우스 이벤트 안 옴)
      });

      // 출발 마커 — 마라톤 배번호판 모양
      const marker = new naver.maps.Marker({
        position: new naver.maps.LatLng(v.start[0], v.start[1]),
        title: event.name + " · " + v.distance,
        icon: { content: bibHtml(event, v), anchor: new naver.maps.Point(6, 6) },
        zIndex: 90,
      });

      // 인포윈도우 (대회 정보 + 이 거리)
      const iw = new naver.maps.InfoWindow({
        content: iwContent(event, v),
        backgroundColor: "transparent",
        borderWidth: 0,
        anchorColor: "#1f242e",
        anchorSize: new naver.maps.Size(14, 12),
        pixelOffset: new naver.maps.Point(0, -6),
      });
      // 코스 위 지점(출발/도착/반환점/급수대/km 등) 핀
      const wpMarkers = (v.waypoints || []).map(
        (wp) =>
          new naver.maps.Marker({
            position: new naver.maps.LatLng(wp.lat, wp.lng),
            icon: { content: wpPinHtml(wp), anchor: new naver.maps.Point(6, 6) },
            zIndex: 70,
            clickable: false,
          })
      );
      overlays[v.vid] = { polyline, marker, infowindow: iw, wpMarkers, event, v, pinned: false, offsetPx: rankToPx(offsetSeq++) };
      GPX_INDEX[v.vid] = { name: event.name + " " + v.distance, path: v.path };
      const o = overlays[v.vid];
      // 마커 클릭=출발 위치 고정, 코스 클릭=커서 위치 고정. 둘 다 조회수 +1.
      naver.maps.Event.addListener(marker, "click", () => openInfo(map, o));
      naver.maps.Event.addListener(polyline, "click", (e) => openInfo(map, o, { position: e.coord }));

      // 코스에 마우스 올리면 커서 위치에 말풍선 + 조회수 +1(고정된 게 아니면). 이동은 커서 따라.
      naver.maps.Event.addListener(polyline, "mouseover", (e) => {
        if (!o.pinned) openInfo(map, o, { position: e.coord, pin: false });
        try { polyline.setOptions({ strokeWeight: 8, strokeOpacity: 1 }); } catch (_) {}
      });
      naver.maps.Event.addListener(polyline, "mousemove", (e) => {
        if (!o.pinned) o.infowindow.open(map, e.coord); // 커서 따라 이동(추가 카운트 없음)
      });
      naver.maps.Event.addListener(polyline, "mouseout", () => {
        if (!o.pinned) o.infowindow.close();
        try { polyline.setOptions({ strokeWeight: 5, strokeOpacity: 0.85 }); } catch (_) {}
      });
    });
  });

  // 코스 표시 = 사이드바 토글(userOn) AND 줌 게이트(coursesShown, 줌≥10)
  // 출발 배번호판은 따로 게이트(bibsShown, 11 이하 숨김 · 12부터 표시)
  let coursesShown = true;
  let bibsShown = true;
  function applyVisOne(o) {
    if (!o) return;
    const show = o.userOn !== false && coursesShown;
    o.polyline.setMap(show ? map : null);
    o.marker.setMap(show && bibsShown ? map : null);
    o.wpMarkers.forEach((m) => m.setMap(show ? map : null));
    if (!show) { o.pinned = false; o.infowindow.close(); }
  }
  function setVisible(vid, on) {
    const o = overlays[vid];
    if (!o) return;
    o.userOn = on;
    applyVisOne(o);
  }
  EVENTS.forEach((e) => e.variants.forEach((v) => setVisible(v.vid, true)));

  // 말풍선(InfoWindow): 지도(배경)를 클릭하면 열려 있는 것 모두 닫기
  function closeAllInfo() {
    EVENTS.forEach((e) => e.variants.forEach((v) => {
      const o = overlays[v.vid];
      if (o) { o.pinned = false; o.infowindow.close(); }
    }));
  }
  naver.maps.Event.addListener(map, "click", closeAllInfo);

  // 배번호판(출발 마커) 크기를 줌 레벨에 맞춰 조절 — CSS 변수 하나로 전체 적용
  function applyBibScale() {
    const z = map.getZoom();
    const scale = Math.max(0.55, Math.min(1.1, 0.55 + (z - 10) * 0.09));
    document.documentElement.style.setProperty("--bib-scale", scale.toFixed(3));
  }
  applyBibScale();
  naver.maps.Event.addListener(map, "zoom_changed", applyBibScale);

  // 겹치는 코스를 나란히 평행선으로 — 줌마다 px 간격 일정하게 다시 계산.
  // 선뿐 아니라 출발 마커·지점 핀도 같은 오프셋으로 옮겨 선 위에 정확히 얹히게.
  function applyOffsets() {
    let proj = null;
    try { proj = map.getProjection(); } catch (_) { proj = null; }
    EVENTS.forEach((e) => e.variants.forEach((v) => {
      const o = overlays[v.vid];
      if (!o) return;
      const trueLL = ([la, ln]) => new naver.maps.LatLng(la, ln);
      // 오프셋 없음/투영 불가 → 전부 원좌표로
      if (!proj || !o.offsetPx) {
        o.polyline.setPath(v.path.map(trueLL));
        o.marker.setPosition(trueLL(v.start));
        o.wpMarkers.forEach((m, k) => m.setPosition(trueLL([v.waypoints[k].lat, v.waypoints[k].lng])));
        return;
      }
      try {
        const off = offsetPath(naver, v.path, o.offsetPx, proj); // v.path와 1:1 인 오프셋 좌표
        o.polyline.setPath(off);
        // 마커/핀: 해당 좌표에 가장 가까운 path 점의 오프셋 위치로 → 선과 정확히 일치
        o.marker.setPosition(off[nearestIdx(v.path, v.start)] || trueLL(v.start));
        o.wpMarkers.forEach((m, k) => {
          const wp = v.waypoints[k];
          m.setPosition(off[nearestIdx(v.path, [wp.lat, wp.lng])] || trueLL([wp.lat, wp.lng]));
        });
      } catch (_) {
        o.polyline.setPath(v.path.map(trueLL));
        o.marker.setPosition(trueLL(v.start));
        o.wpMarkers.forEach((m, k) => m.setPosition(trueLL([v.waypoints[k].lat, v.waypoints[k].lng])));
      }
    }));
  }
  applyOffsets();
  naver.maps.Event.addListener(map, "zoom_changed", applyOffsets);
  naver.maps.Event.once(map, "idle", applyOffsets);

  // ── 줌별 LOD: ≤8=광역 / 9~11=도는 시군·광역시는 통째 / 12+=코스 ──
  let REGIONS = {}; // eventKey -> { sido, sigungu }  (regions.json)
  const aggMarkers = { sido: [], mid: [] };
  // 광역시·특별시·특별자치시(통째로 묶는 단위) — 도는 시/군으로 쪼갬
  const METROS = new Set(["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종"]);
  // region 짧은 이름 → 정식 명칭
  const REGION_FULL = {
    서울: "서울특별시", 부산: "부산광역시", 대구: "대구광역시", 인천: "인천광역시",
    광주: "광주광역시", 대전: "대전광역시", 울산: "울산광역시", 세종: "세종특별자치시",
    경기: "경기도", 강원: "강원특별자치도", 충북: "충청북도", 충남: "충청남도",
    전북: "전북특별자치도", 전남: "전라남도", 경북: "경상북도", 경남: "경상남도", 제주: "제주특별자치도",
  };
  function aggLabel(name, a, kind) {
    const sub = kind === "sido"
      ? a.n + "개 대회 · " + Math.round(a.km).toLocaleString() + "km"
      : a.n + "개 대회";
    return '<div class="agg agg--' + kind + '"><b>' + escHtml(name) + "</b><span>" + sub + "</span></div>";
  }
  function makeAggMarker(name, a, kind) {
    const lat = a.lat / a.c, lng = a.lng / a.c;
    const m = new naver.maps.Marker({
      position: new naver.maps.LatLng(lat, lng),
      icon: { content: aggLabel(name, a, kind), anchor: new naver.maps.Point(0, 0) },
      zIndex: 120,
    });
    naver.maps.Event.addListener(m, "click", () =>
      map.morph(new naver.maps.LatLng(lat, lng), kind === "sido" ? 9 : 12)
    );
    return m;
  }
  function buildAggregates() {
    [].concat(aggMarkers.sido, aggMarkers.mid).forEach((m) => m.setMap(null));
    const bySido = {}, byMid = {};
    const acc = (bag, label, rep, km) => {
      const b = (bag[label] = bag[label] || { n: 0, km: 0, lat: 0, lng: 0, c: 0 });
      b.n++; b.km += km; b.lat += rep[0]; b.lng += rep[1]; b.c++;
    };
    EVENTS.forEach((e) => {
      const rep = e.variants[0] && e.variants[0].start;
      if (!rep) return;
      const km = (e.distancesKm || []).reduce((s, d) => s + (d || 0), 0);
      const region = e.region || "기타";
      const full = REGION_FULL[region] || region;
      acc(bySido, full, rep, km); // ≤8: 광역 전체 이름
      // 9~11: 광역시는 통째(인천광역시), 도는 시/군(아산시·천안시)
      const sgg = (REGIONS[e.id] || REGIONS[e.name] || {}).sigungu;
      acc(byMid, METROS.has(region) ? full : (sgg || full), rep, km);
    });
    aggMarkers.sido = Object.entries(bySido).map(([n, a]) => makeAggMarker(n, a, "sido"));
    aggMarkers.mid = Object.entries(byMid).map(([n, a]) => makeAggMarker(n, a, "mid"));
  }
  function applyLOD() {
    const z = map.getZoom();
    coursesShown = z >= 12;        // 12부터 실제 코스
    bibsShown = z >= 12;           // 배번호판도 12부터
    aggMarkers.sido.forEach((m) => m.setMap(z <= 8 ? map : null));              // ~8: 광역(도·광역시·특별시)
    aggMarkers.mid.forEach((m) => m.setMap(z >= 9 && z <= 11 ? map : null));    // 9~11: 도→시/군, 광역시→통째
    EVENTS.forEach((e) => e.variants.forEach((v) => applyVisOne(overlays[v.vid])));
  }
  naver.maps.Event.addListener(map, "zoom_changed", applyLOD);

  // 현재 줌 레벨 숫자 표시 (확대/축소 시 갱신)
  const zlEl = document.getElementById("zoom-level");
  function showZoom() { if (zlEl) zlEl.textContent = map.getZoom(); }
  showZoom();
  naver.maps.Event.addListener(map, "zoom_changed", showZoom);
  fetch("regions.json")
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => { REGIONS = j || {}; })
    .catch(() => {})
    .finally(() => { buildAggregates(); applyLOD(); });

  // 전체 코스가 보이도록 화면 맞춤
  if (EVENTS.length) map.fitBounds(bounds);

  buildSidebar(setVisible, overlays, map, naver);
  setupMapControls(map, naver);
  setupTools(map, naver, overlays);
  setupLocate(map, naver);
  // 처음 열 때 기본으로 내 위치 기준으로 이동 (권한 거부/실패 시 전체 코스 보기 유지)
  locateMe(map, naver, { silent: true, zoom: 13 });
}

// 내 위치(위경도). 지오로케이션 성공 시 저장 → '가까운 순' 정렬에 사용
let myLocation = null;
// 두 좌표 사이 거리(km) — Haversine
function distKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR;
  const dLng = (bLng - aLng) * toR;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// 지오로케이션으로 지도를 내 위치로 이동 + 마커. opts.silent면 실패해도 알림 X(자동 호출용)
let myLocationMarker = null;
function locateMe(map, naver, opts) {
  opts = opts || {};
  const btn = opts.btn;
  if (!navigator.geolocation) {
    if (!opts.silent) alert("이 브라우저는 위치 기능을 지원하지 않아요.");
    return;
  }
  if (btn) btn.classList.add("is-loading");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btn) btn.classList.remove("is-loading");
      myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const ll = new naver.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
      map.setCenter(ll);
      map.setZoom(opts.zoom || 14, true);
      if (myLocationMarker) myLocationMarker.setMap(null);
      myLocationMarker = new naver.maps.Marker({
        map,
        position: ll,
        zIndex: 1000,
        icon: {
          content: '<div class="me-dot"></div>',
          anchor: new naver.maps.Point(11, 11),
        },
      });
      if (opts.onLocated) opts.onLocated(myLocation);
    },
    () => {
      if (btn) btn.classList.remove("is-loading");
      if (!opts.silent) alert("현위치를 가져오지 못했어요. 위치 권한을 허용했는지 확인해주세요.");
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
  );
}
// 내 현위치 버튼: 클릭 시 내 위치로 이동
function setupLocate(map, naver) {
  const btn = document.getElementById("locate-btn");
  if (!btn) return;
  btn.addEventListener("click", () => locateMe(map, naver, { btn, zoom: 14 }));
}

// 지도 컨트롤(지도유형·줌)을 커스텀 UI로 통일
function setupMapControls(map, naver) {
  // 지도 유형 (일반 / 위성)
  const typeBtns = document.querySelectorAll(".maptype__btn");
  const types = {
    normal: naver.maps.MapTypeId.NORMAL,
    satellite: naver.maps.MapTypeId.HYBRID, // 위성 + 지명 라벨
  };
  typeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      typeBtns.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      map.setMapTypeId(types[btn.dataset.type]);
    });
  });

  // 줌 (+/−)
  document.querySelectorAll(".zoom__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cur = map.getZoom();
      map.setZoom(btn.dataset.zoom === "in" ? cur + 1 : cur - 1, true);
    });
  });
}

// 지도 도구: 거리재기 / 거리뷰 (한 번에 하나만 활성)
function setupTools(map, naver, overlays) {
  const tools = {
    distance: createDistanceTool(map, naver),
    streetview: createStreetViewTool(map, naver, overlays),
  };
  let activeName = null;

  document.querySelectorAll(".tool__btn").forEach((btn) => {
    const name = btn.dataset.tool;
    if (!name) return; // data-tool 없는 버튼(현위치 등)은 setupTools 대상 아님
    btn.addEventListener("click", () => {
      const turnOn = activeName !== name;
      // 기존 도구 끄기
      if (activeName) {
        tools[activeName].setActive(false);
        document
          .querySelector('.tool__btn[data-tool="' + activeName + '"]')
          .classList.remove("is-active");
      }
      if (turnOn) {
        tools[name].setActive(true);
        btn.classList.add("is-active");
        activeName = name;
      } else {
        activeName = null;
      }
    });
  });
}

// 거리재기: 클릭으로 점을 찍어 누적 거리 측정
function createDistanceTool(map, naver) {
  const readout = document.getElementById("dist-readout");
  const valueEl = document.getElementById("dist-value");
  const clearBtn = document.getElementById("dist-clear");

  let points = [];
  let polyline = null;
  let markers = [];
  let clickListener = null;

  function fmt(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
  }
  function haversine(a, b) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (b.lat() - a.lat()) * toR;
    const dLng = (b.lng() - a.lng()) * toR;
    const la1 = a.lat() * toR;
    const la2 = b.lat() * toR;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function total() {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
    return d;
  }
  function redraw() {
    if (polyline) polyline.setMap(null);
    polyline = new naver.maps.Polyline({
      map,
      path: points,
      strokeColor: "#E8413A",
      strokeWeight: 4,
      strokeOpacity: 0.9,
    });
    valueEl.textContent = fmt(total());
  }
  function addPoint(latlng) {
    points.push(latlng);
    markers.push(
      new naver.maps.Marker({
        map,
        position: latlng,
        icon: {
          content: '<div class="dist-dot"></div>',
          anchor: new naver.maps.Point(5, 5),
        },
      })
    );
    redraw();
  }
  function clearAll() {
    if (polyline) polyline.setMap(null);
    polyline = null;
    markers.forEach((m) => m.setMap(null));
    markers = [];
    points = [];
    valueEl.textContent = "0 m";
  }

  clearBtn.addEventListener("click", clearAll);

  return {
    setActive(on) {
      readout.hidden = !on;
      if (on) {
        clickListener = naver.maps.Event.addListener(map, "click", (e) =>
          addPoint(e.coord)
        );
      } else {
        if (clickListener) naver.maps.Event.removeListener(clickListener);
        clickListener = null;
        clearAll();
      }
    },
  };
}

// 거리뷰: 클릭한 위치의 네이버 파노라마 표시
function createStreetViewTool(map, naver, overlays) {
  const panel = document.getElementById("pano");
  const closeBtn = document.getElementById("pano-close");
  let panorama = null;
  let clickListener = null;
  let courseOverlays = []; // 파노라마 위에 그린 코스 경로(폴리라인/마커)
  let center = null; // 현재 파노라마 위치(클릭 지점)

  const STEP_M = 5; // 경로점(마커) 보간 간격(m) — 촘촘할수록 바닥에 누운 선처럼 보임
  const RADIUS_M = 250; // 이 반경 안의 경로만 그림(먼 점은 지평선에 뭉쳐 의미 없음)

  function metersBetween(aLat, aLng, bLat, bLng) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (bLat - aLat) * toR;
    const dLng = (bLng - aLng) * toR;
    const la = ((aLat + bLat) / 2) * toR;
    return (
      R * Math.sqrt(dLat * dLat + Math.cos(la) * Math.cos(la) * dLng * dLng)
    );
  }

  // 방위각(정북 0°, 시계방향) — 카메라가 경로 진행 방향을 보게 할 때 사용
  function bearing(aLat, aLng, bLat, bLng) {
    const toR = Math.PI / 180;
    const toD = 180 / Math.PI;
    const la1 = aLat * toR;
    const la2 = bLat * toR;
    const dLng = (bLng - aLng) * toR;
    const y = Math.sin(dLng) * Math.cos(la2);
    const x =
      Math.cos(la1) * Math.sin(la2) -
      Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (Math.atan2(y, x) * toD + 360) % 360;
  }

  // 듬성듬성한 경유점 사이를 STEP_M 간격으로 보간 → 바닥을 따라 눕는 선
  function densify(path) {
    const out = [];
    for (let i = 0; i < path.length - 1; i++) {
      const [aLat, aLng] = path[i];
      const [bLat, bLng] = path[i + 1];
      const n = Math.max(1, Math.round(metersBetween(aLat, aLng, bLat, bLng) / STEP_M));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.push([aLat + (bLat - aLat) * t, aLng + (bLng - aLng) * t]);
      }
    }
    out.push(path[path.length - 1]);
    return out;
  }

  // 지도에서 켜져 있는 코스들의 경로를 파노라마 바닥(지면)에 표시
  function drawCourses() {
    courseOverlays.forEach((o) => o.setMap(null));
    courseOverlays = [];
    if (!panorama || !center) return;
    const cLat = center.lat();
    const cLng = center.lng();

    let best = null; // 클릭 지점에 가장 가까운 코스(카메라가 이 방향을 봄)

    EVENTS.forEach((event) => {
      event.variants.forEach((v) => {
        const o = overlays[v.vid];
        // 지도에서 꺼둔 코스는 거리뷰에도 그리지 않음
        if (!o || !o.polyline.getMap()) return;

        const dense = densify(v.path);
        // 클릭 지점 반경 안의 보간점만 사용
        const near = [];
        let bestIdx = -1;
        let bestDist = Infinity;
        dense.forEach(([lat, lng], i) => {
          const d = metersBetween(cLat, cLng, lat, lng);
          if (d <= RADIUS_M) near.push([lat, lng]);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        });
        if (near.length < 2) return;

        if (!best || bestDist < best.dist) {
          best = { dense, idx: bestIdx, dist: bestDist };
        }

        // 네이버 파노라마는 폴리라인을 안 그리고 마커만 지면에 투영한다.
        // → 촘촘한 점을 깔아 바닥에 누운 경로선처럼 보이게 함
        //   (가까운 점은 발밑, 먼 점은 멀리 찍혀 길을 따라 누움)
        near.forEach(([lat, lng]) => {
          courseOverlays.push(
            new naver.maps.Marker({
              map: panorama,
              position: new naver.maps.LatLng(lat, lng),
              icon: {
                content:
                  '<div class="pano-dot" style="background:' + v.color + '"></div>',
                anchor: new naver.maps.Point(6, 6),
              },
            })
          );
        });
      });
    });

    // 카메라를 가장 가까운 코스의 진행 방향으로 돌려, 경로가 정면 바닥에 눕게 함
    if (best) {
      const ahead = best.dense[Math.min(best.idx + 8, best.dense.length - 1)];
      const pan = bearing(cLat, cLng, ahead[0], ahead[1]);
      panorama.setPov({ pan, tilt: -8, fov: 100 });
    }
  }

  function openAt(latlng) {
    panel.hidden = false;
    center = latlng;
    if (!panorama) {
      panorama = new naver.maps.Panorama("pano-view", {
        position: latlng,
        pov: { pan: 0, tilt: 0, fov: 100 },
      });
      // 파노라마 준비 완료 후 경로 그리기
      naver.maps.Event.addListener(panorama, "init", drawCourses);
    } else {
      panorama.setPosition(latlng);
      drawCourses();
    }
  }

  closeBtn.addEventListener("click", () => {
    panel.hidden = true;
  });

  return {
    setActive(on) {
      if (on) {
        if (!naver.maps.Panorama) {
          alert("거리뷰 모듈을 불러오지 못했어요.");
          return;
        }
        clickListener = naver.maps.Event.addListener(map, "click", (e) =>
          openAt(e.coord)
        );
      } else {
        if (clickListener) naver.maps.Event.removeListener(clickListener);
        clickListener = null;
      }
    },
  };
}

// 사이드바: 대회별 카드 + 그 아래 거리별(variant) 토글 행
function buildSidebar(setVisible, overlays, map, naver) {
  const ul = document.getElementById("course-list");
  ul.innerHTML = "";

  // 모바일 하단 시트: 제목 탭하면 접기/펴기
  const sidebar = document.querySelector(".sidebar");
  const title = document.querySelector(".sidebar__title");
  if (title && sidebar && !title.dataset.bound) {
    title.dataset.bound = "1";
    title.addEventListener("click", () => sidebar.classList.toggle("is-collapsed"));
  }

  // 검색 필터용 항목 모음 { event, li, variants:[{ v, state }] }
  const items = [];

  EVENTS.forEach((event) => {
    const li = document.createElement("li");
    li.className = "course-item";
    li.innerHTML =
      '<div class="course-item__head">' +
      '  <div class="course-item__name">' + event.name + "</div>" +
      '  <div class="course-item__meta">' +
      '    <span class="course-item__sub">' + event.place + "</span>" +
      '    <span class="course-item__sub">' + event.date + "</span>" +
      "  </div>" +
      "</div>" +
      '<div class="variant-list"></div>';

    const vlist = li.querySelector(".variant-list");
    const variants = [];

    // 거리별 코스를 칩으로 가로 배치 (칩 클릭 = 표시 on/off)
    event.variants.forEach((v) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "variant is-on";
      chip.style.setProperty("--course-color", v.color);
      chip.textContent = v.distance;
      chip.setAttribute("aria-pressed", "true");
      const state = { on: true };

      function sync() {
        chip.classList.toggle("is-on", state.on);
        chip.classList.toggle("is-off", !state.on);
        chip.setAttribute("aria-pressed", String(state.on));
        setVisible(v.vid, state.on);
      }
      chip.addEventListener("click", () => { state.on = !state.on; sync(); });

      vlist.appendChild(chip);
      variants.push({ v, state });
    });

    // 카드 헤드 클릭 → 첫 코스로 지도 이동 + 인포윈도우
    const head = li.querySelector(".course-item__head");
    head.addEventListener("click", () => {
      const v0 = event.variants[0];
      if (!v0) return;
      map.panTo(new naver.maps.LatLng(v0.start[0], v0.start[1]));
      openInfo(map, overlays[v0.vid]); // 마커 클릭과 동일: 조회수 +1 + 내용 갱신
    });

    ul.appendChild(li);
    items.push({ event, li, variants });
  });

  // 정렬: 선택 기준대로 li를 재배치 ("등록순"=원래 순서)
  const sortSel = document.getElementById("sort-select");
  if (sortSel) {
    const feeOf = (e) => (e.feeMin == null ? Infinity : e.feeMin);
    // 내 위치 → 대회 출발점(첫 거리의 start) 거리(km). 위치/좌표 없으면 Infinity(뒤로)
    const nearOf = (e) => {
      const s = e.variants[0] && e.variants[0].start;
      if (!myLocation || !s) return Infinity;
      return distKm(myLocation.lat, myLocation.lng, s[0], s[1]);
    };
    const sorters = {
      name: (a, b) => a.event.name.localeCompare(b.event.name, "ko"),
      date: (a, b) => (a.event.date || "9999-99-99").localeCompare(b.event.date || "9999-99-99"),
      fee: (a, b) => feeOf(a.event) - feeOf(b.event),
      views: (a, b) => (VIEWS[b.event.id] || 0) - (VIEWS[a.event.id] || 0),
      near: (a, b) => nearOf(a.event) - nearOf(b.event),
    };
    const applySort = () => {
      // '가까운 순'인데 아직 내 위치를 모르면 위치부터 받고 다시 정렬
      if (sortSel.value === "near" && !myLocation) {
        locateMe(map, naver, { silent: true, zoom: 13, onLocated: applySort });
        return;
      }
      const fn = sorters[sortSel.value];
      const arr = items.slice();
      if (fn) arr.sort(fn);
      arr.forEach(({ li }) => ul.appendChild(li));
    };
    if (!sortSel.dataset.bound) {
      sortSel.dataset.bound = "1";
      sortSel.addEventListener("change", applySort);
    }
  }

  setupSearch(items, setVisible);
  setupTheme(overlays);
}

// 다크 / 라이트 테마 전환
function setupTheme(overlays) {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const root = document.documentElement;

  // 인포윈도우 꼬리(anchor) 색을 현재 테마에 맞춤
  function syncInfoWindows() {
    const iwbg = getComputedStyle(root).getPropertyValue("--iw-bg").trim();
    Object.keys(overlays).forEach((id) => {
      overlays[id].infowindow.setOptions({ anchorColor: iwbg });
      overlays[id].infowindow.close();
    });
  }
  // 다크모드 → 해(라이트로 전환), 라이트모드 → 달(다크로 전환)
  const SUN =
    '<svg class="ic-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/>' +
    '<path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';
  const MOON =
    '<svg class="ic-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function updateIcon() {
    const isLight = root.getAttribute("data-theme") === "light";
    btn.innerHTML = isLight ? MOON : SUN;
  }

  syncInfoWindows();
  updateIcon();

  btn.addEventListener("click", () => {
    const isLight = root.getAttribute("data-theme") === "light";
    if (isLight) {
      root.removeAttribute("data-theme");
      localStorage.setItem("theme", "dark");
    } else {
      root.setAttribute("data-theme", "light");
      localStorage.setItem("theme", "light");
    }
    syncInfoWindows();
    updateIcon();
  });
}

// 검색: 이름·장소·거리로 코스 필터링 (사이드바 + 지도 동시 반영)
function setupSearch(items, setVisible) {
  const input = document.getElementById("search-input");
  const empty = document.getElementById("search-empty");
  if (!input) return;

  // 필터 상태
  const f = { regions: new Set(), distLo: 0, distHi: 40, feeLo: 0, feeHi: 100000, scale: "all", dateFrom: "", dateTo: "" };

  function passes(ev) {
    if (f.regions.size && !f.regions.has(ev.region)) return false;
    // 거리: [distLo, distHi] 안의 종목이 있는 대회만 (distHi=40 → 상한 없음)
    if (!(f.distLo === 0 && f.distHi === 40)) {
      const hi = f.distHi === 40 ? Infinity : f.distHi;
      if (!ev.distancesKm.some((d) => d >= f.distLo && d <= hi)) return false;
    }
    // 참가비: 최소금액이 [feeLo, feeHi] 안 (feeHi=100000 → 상한 없음)
    if (!(f.feeLo === 0 && f.feeHi === 100000)) {
      const hi = f.feeHi >= 100000 ? Infinity : f.feeHi;
      if (ev.feeMin === null || ev.feeMin < f.feeLo || ev.feeMin > hi) return false;
    }
    if (f.scale !== "all") {
      const s = ev.scale;
      if (s === null) return false;
      if (f.scale === "s" && !(s < 1000)) return false;
      if (f.scale === "m" && !(s >= 1000 && s < 5000)) return false;
      if (f.scale === "l" && !(s >= 5000)) return false;
    }
    if ((f.dateFrom || f.dateTo) && !ev.date) return false;
    if (f.dateFrom && ev.date < f.dateFrom) return false;
    if (f.dateTo && ev.date > f.dateTo) return false;
    return true;
  }

  function apply() {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    items.forEach(({ event, li, variants }) => {
      const hay = (
        event.name + " " + event.place + " " + event.region + " " +
        variants.map((x) => x.v.distance).join(" ")
      ).toLowerCase();
      const match = (q === "" || hay.includes(q)) && passes(event);
      li.hidden = !match;
      variants.forEach(({ v, state }) => setVisible(v.vid, match && state.on));
      if (match) shown++;
    });
    empty.hidden = shown !== 0;
  }

  input.addEventListener("input", apply);

  // 필터 아이콘 → 팝업 토글
  const toggle = document.getElementById("filter-toggle");
  const panel = document.getElementById("filter-panel");
  if (toggle && panel) {
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.classList.toggle("is-active", !panel.hidden);
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    });
  }

  // 지역 칩 (데이터에 존재하는 지역만)
  const regionBox = document.getElementById("filter-regions");
  if (regionBox) {
    const regions = [...new Set(EVENTS.map((e) => e.region).filter(Boolean))].sort();
    if (!regions.length) regionBox.innerHTML = '<span class="filters__none">지역 정보 없음</span>';
    regions.forEach((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = r;
      b.addEventListener("click", () => {
        b.classList.toggle("is-on");
        if (f.regions.has(r)) f.regions.delete(r); else f.regions.add(r);
        apply();
      });
      regionBox.appendChild(b);
    });
  }

  // 선택 구간(fill) 위치 갱신
  function fillRange(el, lo, hi, min, max) {
    if (!el) return;
    const l = ((lo - min) / (max - min)) * 100;
    const r = ((hi - min) / (max - min)) * 100;
    el.style.left = l + "%";
    el.style.width = Math.max(0, r - l) + "%";
  }

  // 거리 듀얼 슬라이더 (단일 트랙, 핸들 2개)
  const dMin = document.getElementById("dist-min");
  const dMax = document.getElementById("dist-max");
  const dFill = document.getElementById("dist-fill");
  const dLabel = document.getElementById("dist-label");
  function syncDist() {
    let lo = Number(dMin.value), hi = Number(dMax.value);
    if (lo > hi) { [lo, hi] = [hi, lo]; dMin.value = lo; dMax.value = hi; }
    f.distLo = lo; f.distHi = hi;
    dLabel.textContent = lo + " ~ " + (hi === 40 ? "40km+" : hi + "km");
    fillRange(dFill, lo, hi, 0, 40);
    apply();
  }
  if (dMin && dMax) { dMin.addEventListener("input", syncDist); dMax.addEventListener("input", syncDist); }

  // 참가비 듀얼 슬라이더 (단일 트랙, 핸들 2개)
  const fMin = document.getElementById("fee-min");
  const fMax = document.getElementById("fee-max");
  const fFill = document.getElementById("fee-fill");
  const feeLabel = document.getElementById("fee-label");
  function syncFee() {
    let lo = Number(fMin.value), hi = Number(fMax.value);
    if (lo > hi) { [lo, hi] = [hi, lo]; fMin.value = lo; fMax.value = hi; }
    f.feeLo = lo; f.feeHi = hi;
    feeLabel.textContent = lo.toLocaleString() + "원 ~ " + (hi >= 100000 ? "무제한" : hi.toLocaleString() + "원");
    fillRange(fFill, lo, hi, 0, 100000);
    apply();
  }
  if (fMin && fMax) { fMin.addEventListener("input", syncFee); fMax.addEventListener("input", syncFee); }

  // 초기 fill (전체 구간)
  fillRange(dFill, 0, 40, 0, 40);
  fillRange(fFill, 0, 100000, 0, 100000);

  // 규모 칩 (단일 선택)
  document.querySelectorAll("#filter-scale .chip").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#filter-scale .chip").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      f.scale = b.dataset.scale;
      apply();
    });
  });

  // 날짜 범위
  const dateFrom = document.getElementById("date-from");
  const dateTo = document.getElementById("date-to");
  if (dateFrom) dateFrom.addEventListener("change", () => { f.dateFrom = dateFrom.value; apply(); });
  if (dateTo) dateTo.addEventListener("change", () => { f.dateTo = dateTo.value; apply(); });

  // 초기화
  const reset = document.getElementById("filter-reset");
  if (reset) reset.addEventListener("click", () => {
    f.regions.clear(); f.distLo = 0; f.distHi = 40; f.feeLo = 0; f.feeHi = 100000; f.scale = "all"; f.dateFrom = ""; f.dateTo = "";
    document.querySelectorAll("#filter-regions .chip").forEach((x) => x.classList.remove("is-on"));
    if (dMin) dMin.value = 0;
    if (dMax) dMax.value = 40;
    if (dLabel) dLabel.textContent = "0 ~ 40km+";
    fillRange(dFill, 0, 40, 0, 40);
    if (fMin) fMin.value = 0;
    if (fMax) fMax.value = 100000;
    if (feeLabel) feeLabel.textContent = "0원 ~ 무제한";
    fillRange(fFill, 0, 100000, 0, 100000);
    document.querySelectorAll("#filter-scale .chip").forEach((x) => x.classList.toggle("is-on", x.dataset.scale === "all"));
    if (dateFrom) dateFrom.value = "";
    if (dateTo) dateTo.value = "";
    input.value = "";
    apply();
  });
}

// 서버(/api/courses)에서 코스를 받아 data.js의 폴백 시드를 덮어씀.
// 서버 없이 python 등으로 띄우면 실패 → data.js의 COURSES 그대로 사용.
function loadCourses() {
  return fetch("/api/courses")
    .then((r) => (r.ok ? r.json() : null))
    .then((list) => {
      if (Array.isArray(list) && list.length) COURSES = list;
    })
    .catch(() => {})
    .then(() => {
      EVENTS = normalizeEvents(COURSES);
    });
}

// ── 조회수 ──────────────────────────────────────────────────────
const VIEWS = {}; // eventId -> count
// 말풍선(InfoWindow) 내용 빌더 (조회수 포함). 열 때 setContent로 갱신용.
function iwContent(event, v) {
  const views = VIEWS[event.id] || 0;
  return '<div class="iw">' +
    '<b class="iw__title">' + event.name + "</b>" +
    '<div class="iw__rows">' +
    '<div class="iw__row"><span class="iw__label">장소</span>' + event.place + "</div>" +
    '<div class="iw__row"><span class="iw__label">거리</span>' + v.distance + "</div>" +
    '<div class="iw__row"><span class="iw__label">일정</span>' + event.date + "</div>" +
    '<div class="iw__row"><span class="iw__label">참가비</span>' + event.fee + "</div>" +
    '<div class="iw__row"><span class="iw__label">조회</span>' + views + "</div>" +
    "</div>" +
    (event.url && event.url !== "#"
      ? '<a class="iw__link" href="' + event.url + '" target="_blank" rel="noopener">공식 사이트</a>'
      : "") +
    '<a class="iw__link iw__gpx" href="#" data-vid="' + v.vid + '">GPX 다운로드</a>' +
    "</div>";
}
// 말풍선 열기 + 조회수 +1 + 새 카운트로 내용 갱신. 마커/사이드바 클릭 공용.
// 같은 코스(대회)는 이 시간 안에 다시 열려도 조회수 중복 카운트 안 함
const VIEW_COOLDOWN_MS = 10000;
const lastBumpAt = {}; // eventId -> ms
// opts.position: 말풍선 위치(기본=출발 마커). opts.pin: false면 고정 안 함(hover용).
function openInfo(map, o, opts) {
  if (!o) return;
  opts = opts || {};
  if (opts.pin !== false) o.pinned = true; // 클릭=고정(마우스 떠나도 안 닫힘), hover=비고정
  o.infowindow.setContent(iwContent(o.event, o.v));
  o.infowindow.open(map, opts.position || o.marker);
  // 쿨다운 안이면 카운트 생략(말풍선은 그대로 보여줌)
  const now = Date.now();
  if (lastBumpAt[o.event.id] && now - lastBumpAt[o.event.id] < VIEW_COOLDOWN_MS) return;
  lastBumpAt[o.event.id] = now;
  bumpView(o.event.id).then((count) => {
    if (count != null) { VIEWS[o.event.id] = count; o.infowindow.setContent(iwContent(o.event, o.v)); }
  });
}
// 조회수 +1 (말풍선 열 때). 새 카운트 반환(실패 시 null).
function bumpView(eid) {
  return fetch("/api/views/" + encodeURIComponent(eid), { method: "POST" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j ? j.count : null))
    .catch(() => null);
}
// 부팅 시 현재 조회수 맵 로드 (말풍선 첫 표시에 반영)
function loadViews() {
  return fetch("/api/views")
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => { if (m && typeof m === "object") Object.assign(VIEWS, m); })
    .catch(() => {});
}

// ── GPX 다운로드 ────────────────────────────────────────────────
const GPX_INDEX = {}; // vid -> { name, path } (InfoWindow 다운로드용)
function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// path([[lat,lng],...]) → GPX 1.1 trk 문자열
function buildGpx(name, path) {
  const pts = (path || [])
    .map(([lat, lng]) => '      <trkpt lat="' + lat + '" lon="' + lng + '"></trkpt>')
    .join("\n");
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="marathang" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    "  <metadata><name>" + escXml(name) + "</name></metadata>\n" +
    "  <trk><name>" + escXml(name) + "</name><trkseg>\n" + pts + "\n  </trkseg></trk>\n</gpx>\n";
}
function gpxFilename(name) {
  const base = String(name).trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
  return (base || "course") + ".gpx";
}
function downloadGpx(filename, text) {
  const blob = new Blob([text], { type: "application/gpx+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// InfoWindow 안의 'GPX 다운로드' 링크 (위임 — 말풍선은 열릴 때 DOM 생성됨)
function setupGpxDownload() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest(".iw__gpx");
    if (!a) return;
    e.preventDefault();
    const rec = GPX_INDEX[a.getAttribute("data-vid")];
    if (!rec || !rec.path || rec.path.length < 2) { alert("내려받을 경로가 없습니다."); return; }
    downloadGpx(gpxFilename(rec.name), buildGpx(rec.name, rec.path));
  });
}
setupGpxDownload();

// ── 사용자 의견(기능 제안 / 문제 신고) ───────────────────────────
function setupFeedback() {
  const openBtn = document.getElementById("fb-open");
  const modal = document.getElementById("fb-modal");
  const form = document.getElementById("fb-form");
  if (!openBtn || !modal || !form) return;
  const contentEl = document.getElementById("fb-content");
  const contactEl = document.getElementById("fb-contact");
  const eventSel = document.getElementById("fb-event");
  const msg = document.getElementById("fb-msg");
  const submitBtn = form.querySelector(".fb-submit");
  const segBtns = form.querySelectorAll(".fb-seg__btn");
  let type = "suggestion";

  function fillEvents() {
    if (eventSel.options.length > 1) return; // 한 번만
    EVENTS.forEach((e) => {
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = e.name;
      eventSel.appendChild(o);
    });
  }
  function setMsg(text, ok) {
    msg.hidden = !text;
    msg.textContent = text || "";
    msg.classList.toggle("fb-msg--ok", !!ok);
    msg.classList.toggle("fb-msg--err", !!text && !ok);
  }
  function setType(t) {
    type = t;
    segBtns.forEach((b) => b.classList.toggle("is-on", b.getAttribute("data-fb-type") === t));
  }
  function open() { fillEvents(); setMsg(""); modal.hidden = false; setTimeout(() => contentEl.focus(), 0); }
  function close() { modal.hidden = true; }

  openBtn.addEventListener("click", open);
  modal.querySelectorAll("[data-fb-close]").forEach((el) => el.addEventListener("click", close));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  segBtns.forEach((b) => b.addEventListener("click", () => setType(b.getAttribute("data-fb-type"))));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const content = contentEl.value.trim();
    if (!content) { setMsg("내용을 입력하세요.", false); contentEl.focus(); return; }
    submitBtn.disabled = true;
    setMsg("보내는 중…");
    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, content, contact: contactEl.value.trim(), eventId: eventSel.value }),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: r.ok, j: {} })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error((j && j.error) || "전송에 실패했어요.");
        form.reset();
        setType("suggestion");
        setMsg("보내주셔서 감사합니다. 잘 전달됐어요.", true);
        setTimeout(close, 1200);
      })
      .catch((err) => setMsg(err.message || "전송에 실패했어요.", false))
      .finally(() => { submitBtn.disabled = false; });
  });
}
setupFeedback();

// 부트스트랩
loadCourses()
  .then(loadViews)
  .then(loadNaverSdk)
  .then(initMap)
  .catch((err) => {
    console.error("[지도 초기화 실패]", err);
    showFallback();
  });
