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
      });

      // 출발 마커
      const marker = new naver.maps.Marker({
        position: new naver.maps.LatLng(v.start[0], v.start[1]),
        title: event.name + " · " + v.distance,
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
      naver.maps.Event.addListener(marker, "click", () => {
        iw.open(map, marker);
        // 말풍선 열 때마다 조회수 +1 → 새 값으로 내용 갱신
        bumpView(event.id).then((count) => {
          if (count != null) { VIEWS[event.id] = count; iw.setContent(iwContent(event, v)); }
        });
      });

      overlays[v.vid] = { polyline, marker, infowindow: iw };
      GPX_INDEX[v.vid] = { name: event.name + " " + v.distance, path: v.path };
    });
  });

  // 처음엔 전부 켜기
  function setVisible(vid, on) {
    const o = overlays[vid];
    if (!o) return;
    o.polyline.setMap(on ? map : null);
    o.marker.setMap(on ? map : null);
    if (!on) o.infowindow.close();
  }
  EVENTS.forEach((e) => e.variants.forEach((v) => setVisible(v.vid, true)));

  // 말풍선(InfoWindow): 지도(배경)를 클릭하면 열려 있는 것 모두 닫기
  function closeAllInfo() {
    EVENTS.forEach((e) => e.variants.forEach((v) => {
      const o = overlays[v.vid];
      if (o) o.infowindow.close();
    }));
  }
  naver.maps.Event.addListener(map, "click", closeAllInfo);

  // 전체 코스가 보이도록 화면 맞춤
  if (EVENTS.length) map.fitBounds(bounds);

  buildSidebar(setVisible, overlays, map, naver);
  setupMapControls(map, naver);
  setupTools(map, naver, overlays);
  setupLocate(map, naver);
}

// 내 현위치: 버튼 클릭 시 지오로케이션으로 지도 이동 + 마커
function setupLocate(map, naver) {
  const btn = document.getElementById("locate-btn");
  if (!btn) return;
  let marker = null;
  btn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("이 브라우저는 위치 기능을 지원하지 않아요.");
      return;
    }
    btn.classList.add("is-loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.classList.remove("is-loading");
        const ll = new naver.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
        map.setCenter(ll);
        map.setZoom(14, true);
        if (marker) marker.setMap(null);
        marker = new naver.maps.Marker({
          map,
          position: ll,
          zIndex: 1000,
          icon: {
            content: '<div class="me-dot"></div>',
            anchor: new naver.maps.Point(11, 11),
          },
        });
      },
      () => {
        btn.classList.remove("is-loading");
        alert("현위치를 가져오지 못했어요. 위치 권한을 허용했는지 확인해주세요.");
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });
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
      const o = overlays[v0.vid];
      map.panTo(new naver.maps.LatLng(v0.start[0], v0.start[1]));
      if (o) o.infowindow.open(map, o.marker);
    });

    ul.appendChild(li);
    items.push({ event, li, variants });
  });

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
