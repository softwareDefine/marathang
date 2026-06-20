// ────────────────────────────────────────────────────────────────
// marathang 어드민
//   - 비밀번호 로그인 → 대회 추가/수정/삭제
//   - 대회 1개가 거리별 코스(variant) 여러 개를 가짐
//   - 각 거리별 코스: GPX 업로드 또는 지도에서 직접 그리기
// ────────────────────────────────────────────────────────────────

const NAVER_CLIENT_ID = "22szac44wv"; // app.js와 동일 키
const API = "/api/courses";
const LOCKS_API = "/api/locks";
const PW_KEY = "marathang_admin_pw";
const OWNER_KEY = "marathang_edit_owner"; // 이 기기(브라우저)의 편집자 식별 토큰
const NAME_KEY = "marathang_editor_name"; // 화면에 보일 편집자 이름

let pw = sessionStorage.getItem(PW_KEY) || "";
// 편집자 식별 토큰: 기기(브라우저)마다 고유하게 localStorage에 고정.
// 브라우저는 MAC 주소를 못 읽으므로, 그 등가물로 기기 단위 안정 ID를 쓴다.
// 새 탭·새로고침·브라우저 재시작에도 동일 owner → 자기 락에 자기가 막히는 "락 걸기 실패"가 사라짐.
// (예전엔 sessionStorage라 탭마다 owner가 달라, 이전 세션이 잡아둔 내 락(TTL 90초)이 새 탭의 나를 차단했음)
let owner = localStorage.getItem(OWNER_KEY) || "";
if (!owner) {
  const rand = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  owner = "dev-" + rand;
  localStorage.setItem(OWNER_KEY, owner);
}
let editorName = localStorage.getItem(NAME_KEY) || "";
let locksCache = {};        // { courseId: {owner,name,expires} }
let heartbeatTimer = null;  // 편집 중 락 갱신 타이머
let locksPollTimer = null;  // 목록 락 배지 갱신 타이머
let editingId = null;       // 수정 중인 대회 id (null=추가)
let coursesCache = [];      // 목록 원본
let naverReady = false;
let editorMap = null;
let variants = [];          // 거리별 행 [{el, distEl, colorEl, gpxEl, drawWrap, infoEl, path, line, dots}]
let drawIdx = -1;           // 지도 그리기로 무장된 행 인덱스 (-1=없음)
let vseq = 0;               // 라디오 name 고유값

// ── 거리 계산 / GPX 처리 ────────────────────────────────────────
function meters(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const la = ((a[0] + b[0]) / 2) * toR;
  return R * Math.sqrt(dLat * dLat + Math.cos(la) * Math.cos(la) * dLng * dLng);
}
function totalKm(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += meters(path[i - 1], path[i]);
  return d / 1000;
}
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("GPX 형식이 아닙니다.");
  let nodes = doc.getElementsByTagName("trkpt");
  if (!nodes.length) nodes = doc.getElementsByTagName("rtept");
  if (!nodes.length) nodes = doc.getElementsByTagName("wpt");
  const path = [...nodes]
    .map((p) => [parseFloat(p.getAttribute("lat")), parseFloat(p.getAttribute("lon"))])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (path.length < 2) throw new Error("좌표(trkpt)를 2개 이상 찾지 못했습니다.");
  return path;
}
function downsample(path, stepM) {
  if (path.length <= 2) return path.slice();
  const out = [path[0]];
  let last = path[0];
  for (let i = 1; i < path.length - 1; i++) {
    if (meters(last, path[i]) >= stepM) { out.push(path[i]); last = path[i]; }
  }
  out.push(path[path.length - 1]);
  return out;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// ── 네이버 지도(에디터) ─────────────────────────────────────────
function loadNaver() {
  return new Promise((resolve) => {
    if (window.naver && window.naver.maps) { naverReady = true; return resolve(); }
    const s = document.createElement("script");
    s.src = "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=" + NAVER_CLIENT_ID;
    s.onload = () => { naverReady = !!(window.naver && window.naver.maps); resolve(); };
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}
function ensureMap() {
  if (editorMap || !naverReady) return;
  const naver = window.naver;
  editorMap = new naver.maps.Map("editor-map", {
    center: new naver.maps.LatLng(37.54, 126.99),
    zoom: 11,
    mapDataControl: false,
    scaleControl: false,
    logoControl: false,
  });
  naver.maps.Event.addListener(editorMap, "click", (e) => {
    if (drawIdx >= 0 && variants[drawIdx]) {
      variants[drawIdx].path.push([e.coord.lat(), e.coord.lng()]);
      redrawVariant(drawIdx);
      updateInfo(drawIdx);
    }
  });
  setTimeout(() => naver.maps.Event.trigger(editorMap, "resize"), 60);
  variants.forEach((_, i) => redrawVariant(i));
}
function redrawVariant(i) {
  const v = variants[i];
  if (!v) return;
  if (v.line) { v.line.setMap(null); v.line = null; }
  v.dots.forEach((d) => d.setMap(null));
  v.dots = [];
  if (!naverReady || !editorMap) return;
  const naver = window.naver;
  const color = v.colorEl.value;
  if (v.path.length >= 2) {
    v.line = new naver.maps.Polyline({
      map: editorMap,
      path: v.path.map((p) => new naver.maps.LatLng(p[0], p[1])),
      strokeColor: color,
      strokeWeight: 5,
      strokeOpacity: 0.9,
      strokeLineCap: "round",
      strokeLineJoin: "round",
    });
  }
  // 그리기 중인 행은 꼭짓점 점 표시
  if (i === drawIdx) {
    v.path.forEach((p) => {
      v.dots.push(new naver.maps.Marker({
        map: editorMap,
        position: new naver.maps.LatLng(p[0], p[1]),
        icon: { content: '<div class="edit-dot" style="background:' + color + '"></div>', anchor: new naver.maps.Point(5, 5) },
      }));
    });
  }
}
function fitAll() {
  if (!naverReady || !editorMap) return;
  const naver = window.naver;
  const b = new naver.maps.LatLngBounds();
  let any = false;
  variants.forEach((v) => v.path.forEach((p) => { b.extend(new naver.maps.LatLng(p[0], p[1])); any = true; }));
  if (any) setTimeout(() => { naver.maps.Event.trigger(editorMap, "resize"); editorMap.fitBounds(b); }, 60);
}
function updateInfo(i) {
  const v = variants[i];
  if (!v) return;
  v.infoEl.classList.remove("gpx-info--err");
  v.infoEl.textContent = v.path.length >= 2
    ? v.path.length + "점 · " + totalKm(v.path).toFixed(2) + "km"
    : "경로 없음 (GPX 업로드 또는 지도 그리기)";
}

// ── 거리별 기본 색상 ────────────────────────────────────────────
// 거리 문자열 → 대표 km ("풀"=42.195, "하프"=21.1, "10km"/"10" → 10)
function parseDistKm(str) {
  const s = String(str || "");
  if (/풀/.test(s)) return 42.195;
  if (/하프/.test(s)) return 21.1;
  const m = s.match(/(\d+(?:\.\d+)?)\s*km/i) || s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
// 거리 구간별 기본색. km 없으면 null(=색 유지)
function colorForDistance(km) {
  if (km == null || !isFinite(km)) return null;
  if (km < 5) return "#FF8A1E";   // 5km 미만 주황
  if (km < 10) return "#E8413A";  // 5~10 빨강
  if (km < 20) return "#3BE84F";  // 10~20 연두
  if (km < 40) return "#3BC5E8";  // 20~40 민트
  return "#3B74E8";               // 40+ 파랑
}

// ── 거리별 행 ───────────────────────────────────────────────────
function addVariantRow(data) {
  data = data || {};
  const id = "vmode" + (vseq++);
  const el = document.createElement("div");
  el.className = "vrow";
  el.innerHTML =
    '<div class="vrow__top">' +
    '  <div class="vrow__order">' +
    '    <button type="button" class="vrow__move vrow__up" title="위로" aria-label="위로"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button>' +
    '    <button type="button" class="vrow__move vrow__down" title="아래로" aria-label="아래로"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' +
    '  </div>' +
    '  <input class="field__input vrow__dist" placeholder="거리 (예: 10km)">' +
    '  <input class="field__color vrow__color" type="color" value="' + (data.color || "#E8413A") + '">' +
    '  <button type="button" class="btn btn--ghost btn--sm vrow__dup" title="이 경로를 복제해 새 거리 추가">복제</button>' +
    '  <button type="button" class="btn btn--ghost btn--sm vrow__gpxdl" title="이 거리 경로를 GPX로 다운로드">GPX</button>' +
    '  <button type="button" class="btn btn--danger btn--sm vrow__del">삭제</button>' +
    "</div>" +
    '<div class="vrow__mode">' +
    '  <label><input type="radio" name="' + id + '" value="gpx" checked> GPX 업로드</label>' +
    '  <label><input type="radio" name="' + id + '" value="draw"> 지도에서 그리기</label>' +
    "</div>" +
    '<input type="file" class="field__input vrow__gpx" accept=".gpx,application/gpx+xml,text/xml">' +
    '<div class="vrow__draw" hidden>' +
    '  <button type="button" class="btn btn--ghost btn--sm vrow__undo">되돌리기</button>' +
    '  <button type="button" class="btn btn--ghost btn--sm vrow__clear">지우기</button>' +
    '  <span class="vrow__armed">지도 클릭으로 점 찍는 중</span>' +
    "</div>" +
    '<p class="vrow__info gpx-info"></p>';
  document.getElementById("variant-rows").appendChild(el);

  const v = {
    el,
    distEl: el.querySelector(".vrow__dist"),
    colorEl: el.querySelector(".vrow__color"),
    gpxEl: el.querySelector(".vrow__gpx"),
    drawWrap: el.querySelector(".vrow__draw"),
    infoEl: el.querySelector(".vrow__info"),
    path: Array.isArray(data.path) ? data.path.slice() : [],
    line: null,
    dots: [],
    // 색을 사용자가 직접 골랐는지. 기존/복제 색(data.color)이 있으면 보존, 새 행이면 거리로 자동 결정.
    colorTouched: !!(data && data.color),
  };
  v.distEl.value = data.distance || "";
  variants.push(v);

  v.colorEl.addEventListener("input", () => { v.colorTouched = true; redrawVariant(variants.indexOf(v)); });
  // 거리 입력 시 색을 거리 구간 기본색으로 자동 설정 (사용자가 색을 직접 고르기 전까지)
  v.distEl.addEventListener("input", () => {
    if (v.colorTouched) return;
    const c = colorForDistance(parseDistKm(v.distEl.value));
    if (c) { v.colorEl.value = c; redrawVariant(variants.indexOf(v)); }
  });
  v.gpxEl.addEventListener("change", () => { if (v.gpxEl.files[0]) handleGpx(variants.indexOf(v), v.gpxEl.files[0]); });
  el.querySelector(".vrow__dup").addEventListener("click", () => {
    // 같은 경로를 복제해 새 거리 행 추가 (5km/10km/하프/풀이 경로 겹칠 때)
    addVariantRow({ distance: v.distEl.value, color: v.colorEl.value, path: v.path.slice() });
    fitAll();
  });
  el.querySelector(".vrow__up").addEventListener("click", () => moveVariant(variants.indexOf(v), -1));
  el.querySelector(".vrow__down").addEventListener("click", () => moveVariant(variants.indexOf(v), 1));
  el.querySelector(".vrow__gpxdl").addEventListener("click", () => downloadVariantGpx(variants.indexOf(v)));
  el.querySelector(".vrow__del").addEventListener("click", () => removeVariant(variants.indexOf(v)));
  el.querySelectorAll('input[type="radio"]').forEach((r) =>
    r.addEventListener("change", () => setMode(variants.indexOf(v), el.querySelector('input[type="radio"]:checked').value))
  );
  el.querySelector(".vrow__undo").addEventListener("click", () => {
    const idx = variants.indexOf(v); v.path.pop(); redrawVariant(idx); updateInfo(idx);
  });
  el.querySelector(".vrow__clear").addEventListener("click", () => {
    const idx = variants.indexOf(v); v.path = []; redrawVariant(idx); updateInfo(idx);
  });

  const idx = variants.indexOf(v);
  updateInfo(idx);
  redrawVariant(idx);
  refreshOrderButtons();
  return v;
}
// 거리별 코스 순서 이동 (dir: -1 위 / +1 아래). 저장 순서 = variants 배열 순서.
function moveVariant(i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= variants.length) return;
  const tmp = variants[i]; variants[i] = variants[j]; variants[j] = tmp;
  const container = document.getElementById("variant-rows");
  variants.forEach((v) => container.appendChild(v.el)); // 배열 순서대로 DOM 재배치
  // 그리기로 무장된 행 인덱스를 따라가게
  if (drawIdx === i) drawIdx = j;
  else if (drawIdx === j) drawIdx = i;
  variants.forEach((v, idx) => v.el.classList.toggle("is-armed", idx === drawIdx));
  refreshOrderButtons();
}
// 첫 행은 위로, 마지막 행은 아래로 비활성
function refreshOrderButtons() {
  variants.forEach((v, idx) => {
    const up = v.el.querySelector(".vrow__up");
    const down = v.el.querySelector(".vrow__down");
    if (up) up.disabled = idx === 0;
    if (down) down.disabled = idx === variants.length - 1;
  });
}
// ── GPX 다운로드 (거리 행의 현재 경로를 그대로) ──────────────────
function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
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
function downloadVariantGpx(i) {
  const v = variants[i];
  if (!v || v.path.length < 2) {
    alert("내려받을 경로가 없습니다. GPX를 업로드하거나 지도에서 그려주세요.");
    return;
  }
  const eventName = (document.querySelector('#course-form [name="name"]').value || "").trim();
  const dist = (v.distEl.value || "").trim();
  const name = (eventName + (dist ? " " + dist : "")).trim() || "course";
  downloadGpx(gpxFilename(name), buildGpx(name, v.path));
}
function setMode(i, mode) {
  const v = variants[i];
  if (!v) return;
  if (mode === "draw") {
    v.gpxEl.hidden = true;
    v.drawWrap.hidden = false;
    arm(i);
  } else {
    v.gpxEl.hidden = false;
    v.drawWrap.hidden = true;
    if (drawIdx === i) { drawIdx = -1; redrawVariant(i); }
    v.el.classList.remove("is-armed");
  }
}
function arm(i) {
  const prev = drawIdx;
  drawIdx = i;
  variants.forEach((v, idx) => v.el.classList.toggle("is-armed", idx === i));
  if (prev >= 0 && prev !== i && variants[prev]) redrawVariant(prev);
  redrawVariant(i);
}
function removeVariant(i) {
  const v = variants[i];
  if (!v) return;
  if (v.line) v.line.setMap(null);
  v.dots.forEach((d) => d.setMap(null));
  v.el.remove();
  variants.splice(i, 1);
  if (drawIdx === i) drawIdx = -1;
  else if (drawIdx > i) drawIdx--;
  variants.forEach((vv, idx) => vv.el.classList.toggle("is-armed", idx === drawIdx));
  refreshOrderButtons();
}
function handleGpx(i, file) {
  const reader = new FileReader();
  reader.onload = () => {
    const v = variants[i];
    if (!v) return;
    try {
      const full = parseGpx(reader.result);
      const step = Math.max(5, Number(document.getElementById("step").value) || 30);
      v.path = downsample(full, step);
      redrawVariant(i);
      fitAll();
      v.infoEl.classList.remove("gpx-info--err");
      v.infoEl.textContent = "원본 " + full.length + "점 → " + v.path.length + "점 · " + totalKm(full).toFixed(2) + "km";
    } catch (e) {
      v.infoEl.classList.add("gpx-info--err");
      v.infoEl.textContent = e.message;
    }
  };
  reader.readAsText(file);
}
function clearVariants() {
  variants.slice().forEach((v) => {
    if (v.line) v.line.setMap(null);
    v.dots.forEach((d) => d.setMap(null));
    v.el.remove();
  });
  variants.length = 0;
  drawIdx = -1;
  document.getElementById("variant-rows").innerHTML = "";
}

// ── 서버 통신 ───────────────────────────────────────────────────
function api(method, url, body, opts) {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-admin-password": pw, "x-edit-owner": owner },
    body: body ? JSON.stringify(body) : undefined,
    ...(opts || {}),
  });
}

// ── 편집 락 ─────────────────────────────────────────────────────
// 표시 이름: 기기 ID에서 자동 생성한 고정 라벨(사용자-XXXX). 브라우저가 MAC을 못 주므로 owner 끝 4자로 대체.
// localStorage에 굳혀 같은 기기는 항상 같은 라벨로 보임. (직접 이름을 쓰고 싶으면 renameEditor 사용)
function ensureName() {
  if (editorName) return editorName;
  const tag = owner.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase() || "0000";
  editorName = "사용자-" + tag;
  localStorage.setItem(NAME_KEY, editorName);
  return editorName;
}
// 원하면 콘솔/버튼에서 사람이 직접 이름 지정 (예: renameEditor("주호"))
function renameEditor(name) {
  editorName = String(name || "").trim() || editorName;
  localStorage.setItem(NAME_KEY, editorName);
  return editorName;
}
// 락 획득. 성공 true / 남이 잡고 있으면 false(알림)
async function acquireLock(id) {
  ensureName();
  const res = await api("POST", LOCKS_API + "/" + encodeURIComponent(id), { name: editorName });
  if (res.ok) return true;
  if (res.status === 409) {
    const info = await res.json().catch(() => ({}));
    alert((info.holder || "다른 사람") + "님이 편집 중입니다. 끝난 뒤 다시 시도하세요.");
    loadLocks();
    return false;
  }
  alert("락 획득 실패: " + ((await res.json().catch(() => ({}))).error || res.status));
  return false;
}
function startHeartbeat(id) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    api("POST", LOCKS_API + "/" + encodeURIComponent(id), { name: editorName }).catch(() => {});
  }, 30_000); // 서버 TTL 90초 → 30초마다 갱신
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}
function releaseLock(id, beacon) {
  if (!id) return;
  stopHeartbeat();
  api("DELETE", LOCKS_API + "/" + encodeURIComponent(id), null, beacon ? { keepalive: true } : null).catch(() => {});
}
async function loadLocks() {
  try {
    const res = await api("GET", LOCKS_API);
    locksCache = res.ok ? await res.json() : {};
  } catch { locksCache = {}; }
  renderLockBadges();
}
// 목록 행에 락 상태 반영 (남의 락이면 배지 + 버튼 비활성)
function renderLockBadges() {
  document.querySelectorAll(".admin-row[data-id]").forEach((li) => {
    const id = li.getAttribute("data-id");
    const lock = locksCache[id];
    const badge = li.querySelector(".admin-row__lock");
    const editBtn = li.querySelector('[data-act="edit"]');
    const delBtn = li.querySelector('[data-act="del"]');
    const mine = lock && lock.owner === owner;
    const othersLock = lock && !mine;
    if (badge) {
      badge.hidden = !lock;
      badge.textContent = lock ? (mine ? "내가 편집 중" : (lock.name || "다른 사람") + " 편집 중") : "";
      badge.classList.toggle("admin-row__lock--mine", !!mine);
    }
    if (editBtn) editBtn.disabled = !!othersLock;
    if (delBtn) delBtn.disabled = !!othersLock;
  });
}
async function loadList() {
  const res = await fetch(API);
  const list = res.ok ? await res.json() : [];
  coursesCache = list;
  let views = {};
  try { const vr = await fetch("/api/views"); if (vr.ok) views = await vr.json(); } catch {}
  const ul = document.getElementById("list");
  document.getElementById("count").textContent = "(" + list.length + ")";
  ul.innerHTML = "";
  if (!list.length) { ul.innerHTML = '<li class="admin-list__empty">아직 없음</li>'; return; }
  list.forEach((c) => {
    const vs = Array.isArray(c.variants) ? c.variants : [{ distance: c.distance, color: c.color, path: c.path }];
    const dists = vs.map((v) => (v.distance || "?")).join(", ");
    const color = (vs[0] && vs[0].color) || "#888";
    const li = document.createElement("li");
    li.className = "admin-row";
    li.setAttribute("data-id", c.id);
    li.innerHTML =
      '<span class="admin-row__dot" style="background:' + color + '"></span>' +
      '<div class="admin-row__body">' +
      '  <div class="admin-row__name">' + escapeHtml(c.name) +
      '    <span class="admin-row__lock" hidden></span>' +
      "  </div>" +
      '  <div class="admin-row__meta">' +
      escapeHtml(c.place || "") + " · " + escapeHtml(c.date || "") +
      " · 거리 " + vs.length + "개: " + escapeHtml(dists) +
      " · 조회 " + (Number(views[c.id]) || 0) + "</div>" +
      "</div>" +
      '<div class="admin-row__actions">' +
      '  <button class="btn btn--ghost" data-act="edit">수정</button>' +
      '  <button class="btn btn--danger" data-act="del">삭제</button>' +
      "</div>";
    li.querySelector('[data-act="edit"]').addEventListener("click", () => startEdit(c.id));
    li.querySelector('[data-act="del"]').addEventListener("click", () => removeCourse(c.id, c.name));
    ul.appendChild(li);
  });
  loadLocks(); // 방금 그린 행에 락 배지 입히기
}
async function removeCourse(id, name) {
  if (!confirm('"' + name + '" 대회를 삭제할까요?')) return;
  const res = await api("DELETE", API + "/" + encodeURIComponent(id));
  if (res.ok) loadList();
  else alert("삭제 실패: " + (await res.json()).error);
}

// ── 추가/수정 ───────────────────────────────────────────────────
async function startEdit(id) {
  const c = coursesCache.find((x) => x.id === id);
  if (!c) return;
  if (editingId && editingId !== id) releaseLock(editingId); // 다른 걸 편집 중이었으면 그 락부터 놓기
  if (!(await acquireLock(id))) return; // 남이 편집 중이면 진입 차단
  startHeartbeat(id);
  clearVariants();
  const form = document.getElementById("course-form");
  form.name.value = c.name || "";
  form.date.value = c.date || "";
  form.place.value = c.place || "";
  form.region.value = c.region || "";
  form.scale.value = c.scale != null ? c.scale : "";
  form.fee.value = c.fee || "";
  form.url.value = c.url && c.url !== "#" ? c.url : "";
  editingId = id;
  document.getElementById("form-title").textContent = "마라톤 수정";
  document.getElementById("submit-btn").textContent = "수정 저장";
  document.getElementById("cancel-edit").hidden = false;

  const vs = Array.isArray(c.variants) ? c.variants : [{ distance: c.distance, color: c.color, path: c.path }];
  (vs.length ? vs : [{}]).forEach((v) => addVariantRow({ distance: v.distance, color: v.color, path: v.path }));
  fitAll();
  document.querySelector(".admin__main").scrollIntoView({ behavior: "smooth" });
}
function resetForm() {
  if (editingId) releaseLock(editingId); // 취소/저장 시 락 해제
  document.getElementById("course-form").reset();
  editingId = null;
  document.getElementById("form-title").textContent = "마라톤 추가";
  document.getElementById("submit-btn").textContent = "코스 추가";
  document.getElementById("cancel-edit").hidden = true;
  clearVariants();
  addVariantRow();
}
async function submitForm(e) {
  e.preventDefault();
  const msg = document.getElementById("form-msg");
  const form = e.target;
  const built = [];
  variants.forEach((v) => {
    if (v.path.length >= 2) built.push({ distance: v.distEl.value.trim(), color: v.colorEl.value, path: v.path });
  });
  if (!built.length) {
    showMsg(msg, "경로가 있는 거리별 코스를 1개 이상 추가하세요 (GPX 업로드 또는 지도에서 그리기).", true);
    return;
  }
  const fd = new FormData(form);
  const ev = {
    name: fd.get("name"), date: fd.get("date"), place: fd.get("place"),
    region: fd.get("region"), scale: fd.get("scale"),
    fee: fd.get("fee"), url: fd.get("url"), variants: built,
  };
  const res = editingId
    ? await api("PUT", API + "/" + encodeURIComponent(editingId), ev)
    : await api("POST", API, ev);
  if (res.ok) {
    showMsg(msg, editingId ? "수정됐습니다." : "추가됐습니다. 지도에서 확인하세요.", false);
    resetForm();
    loadList();
  } else {
    showMsg(msg, "실패: " + (await res.json()).error, true);
  }
}
function showMsg(el, text, isErr) {
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("form-msg--err", !!isErr);
}

// ── 사용자 의견함 ───────────────────────────────────────────────
let fbCache = [];
let fbFilter = "all"; // all | new | done
function fbDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
async function loadFeedback() {
  try {
    const res = await api("GET", "/api/feedback");
    fbCache = res.ok ? await res.json() : [];
  } catch { fbCache = []; }
  renderFeedback();
}
function renderFeedback() {
  const ul = document.getElementById("fb-list");
  const countEl = document.getElementById("fb-count");
  if (!ul) return;
  const items = fbCache.filter((f) => fbFilter === "all" || (f.status || "new") === fbFilter);
  const newCount = fbCache.filter((f) => (f.status || "new") !== "done").length;
  if (countEl) countEl.textContent = newCount ? "신규 " + newCount : "";
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML = '<li class="fb-admin-empty">접수된 의견이 없습니다.</li>';
    return;
  }
  items.forEach((f) => {
    const done = (f.status || "new") === "done";
    const isBug = f.type === "bug";
    const li = document.createElement("li");
    li.className = "fb-admin-row" + (done ? " is-done" : "");
    li.innerHTML =
      '<div class="fb-admin-row__top">' +
      '  <span class="fb-tag fb-tag--' + (isBug ? "bug" : "sug") + '">' + (isBug ? "문제 신고" : "기능 제안") + "</span>" +
      '  <span class="fb-admin-row__date">' + fbDate(f.at) + "</span>" +
      "</div>" +
      '<div class="fb-admin-row__content">' + escapeHtml(f.content || "") + "</div>" +
      '<div class="fb-admin-row__meta">' +
      (f.eventName ? '<span class="fb-admin-row__chip">대회: ' + escapeHtml(f.eventName) + "</span>" : "") +
      (f.contact ? '<span class="fb-admin-row__chip">연락처: ' + escapeHtml(f.contact) + "</span>" : "") +
      "</div>" +
      '<div class="fb-admin-row__actions">' +
      '  <button type="button" class="btn btn--ghost btn--sm" data-fb-act="toggle">' + (done ? "신규로 되돌리기" : "처리완료") + "</button>" +
      '  <button type="button" class="btn btn--ghost btn--sm" data-fb-act="del">삭제</button>' +
      "</div>";
    li.querySelector('[data-fb-act="toggle"]').addEventListener("click", () => toggleFeedback(f.id, done ? "new" : "done"));
    li.querySelector('[data-fb-act="del"]').addEventListener("click", () => deleteFeedback(f.id));
    ul.appendChild(li);
  });
}
async function toggleFeedback(id, status) {
  const res = await api("PUT", "/api/feedback/" + encodeURIComponent(id), { status });
  if (res.ok) loadFeedback();
}
async function deleteFeedback(id) {
  if (!confirm("이 의견을 삭제할까요?")) return;
  const res = await api("DELETE", "/api/feedback/" + encodeURIComponent(id));
  if (res.ok) loadFeedback();
}
// 필터 칩 (DOM에 항상 존재 → 로드 시 1회 배선)
document.querySelectorAll("[data-fbf]").forEach((b) => {
  b.addEventListener("click", () => {
    fbFilter = b.getAttribute("data-fbf");
    document.querySelectorAll("[data-fbf]").forEach((x) => x.classList.toggle("is-on", x === b));
    renderFeedback();
  });
});

// ── 로그인 / 부트스트랩 ─────────────────────────────────────────
async function checkPw(candidate) {
  const res = await fetch("/api/auth", { headers: { "x-admin-password": candidate } });
  return res.ok;
}
async function showApp() {
  document.getElementById("login").hidden = true;
  document.getElementById("app").hidden = false;
  loadList();
  loadFeedback();
  if (!locksPollTimer) locksPollTimer = setInterval(loadLocks, 12_000); // 남의 락 변화 반영
  await loadNaver();
  ensureMap();
  if (!variants.length) addVariantRow();
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cand = document.getElementById("login-pw").value;
  const err = document.getElementById("login-error");
  if (await checkPw(cand)) {
    pw = cand;
    sessionStorage.setItem(PW_KEY, pw);
    err.hidden = true;
    showApp();
  } else {
    err.hidden = false;
  }
});
document.getElementById("logout").addEventListener("click", () => {
  if (editingId) releaseLock(editingId);
  sessionStorage.removeItem(PW_KEY);
  location.reload();
});
// 탭 닫기/이동 시 락 해제 시도 (실패해도 TTL로 자동 만료됨)
window.addEventListener("pagehide", () => { if (editingId) releaseLock(editingId, true); });
document.getElementById("add-variant").addEventListener("click", () => addVariantRow());
document.getElementById("course-form").addEventListener("submit", submitForm);
document.getElementById("cancel-edit").addEventListener("click", resetForm);

(async () => {
  if (pw && (await checkPw(pw))) showApp();
})();
