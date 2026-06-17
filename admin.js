// ────────────────────────────────────────────────────────────────
// marathang 어드민
//   - 비밀번호 로그인 → 대회 추가/수정/삭제
//   - 대회 1개가 거리별 코스(variant) 여러 개를 가짐
//   - 각 거리별 코스: GPX 업로드 또는 지도에서 직접 그리기
// ────────────────────────────────────────────────────────────────

const NAVER_CLIENT_ID = "22szac44wv"; // app.js와 동일 키
const API = "/api/courses";
const PW_KEY = "marathang_admin_pw";

let pw = sessionStorage.getItem(PW_KEY) || "";
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

// ── 거리별 행 ───────────────────────────────────────────────────
function addVariantRow(data) {
  data = data || {};
  const id = "vmode" + (vseq++);
  const el = document.createElement("div");
  el.className = "vrow";
  el.innerHTML =
    '<div class="vrow__top">' +
    '  <input class="field__input vrow__dist" placeholder="거리 (예: 10km)">' +
    '  <input class="field__color vrow__color" type="color" value="' + (data.color || "#E8413A") + '">' +
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
  };
  v.distEl.value = data.distance || "";
  variants.push(v);

  v.colorEl.addEventListener("input", () => redrawVariant(variants.indexOf(v)));
  v.gpxEl.addEventListener("change", () => { if (v.gpxEl.files[0]) handleGpx(variants.indexOf(v), v.gpxEl.files[0]); });
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
  return v;
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
function api(method, url, body) {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-admin-password": pw },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function loadList() {
  const res = await fetch(API);
  const list = res.ok ? await res.json() : [];
  coursesCache = list;
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
    li.innerHTML =
      '<span class="admin-row__dot" style="background:' + color + '"></span>' +
      '<div class="admin-row__body">' +
      '  <div class="admin-row__name">' + escapeHtml(c.name) + "</div>" +
      '  <div class="admin-row__meta">' +
      escapeHtml(c.place || "") + " · " + escapeHtml(c.date || "") +
      " · 거리 " + vs.length + "개: " + escapeHtml(dists) + "</div>" +
      "</div>" +
      '<div class="admin-row__actions">' +
      '  <button class="btn btn--ghost" data-act="edit">수정</button>' +
      '  <button class="btn btn--danger" data-act="del">삭제</button>' +
      "</div>";
    li.querySelector('[data-act="edit"]').addEventListener("click", () => startEdit(c.id));
    li.querySelector('[data-act="del"]').addEventListener("click", () => removeCourse(c.id, c.name));
    ul.appendChild(li);
  });
}
async function removeCourse(id, name) {
  if (!confirm('"' + name + '" 대회를 삭제할까요?')) return;
  const res = await api("DELETE", API + "/" + encodeURIComponent(id));
  if (res.ok) loadList();
  else alert("삭제 실패: " + (await res.json()).error);
}

// ── 추가/수정 ───────────────────────────────────────────────────
function startEdit(id) {
  const c = coursesCache.find((x) => x.id === id);
  if (!c) return;
  clearVariants();
  const form = document.getElementById("course-form");
  form.name.value = c.name || "";
  form.date.value = c.date || "";
  form.place.value = c.place || "";
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

// ── 로그인 / 부트스트랩 ─────────────────────────────────────────
async function checkPw(candidate) {
  const res = await fetch("/api/auth", { headers: { "x-admin-password": candidate } });
  return res.ok;
}
async function showApp() {
  document.getElementById("login").hidden = true;
  document.getElementById("app").hidden = false;
  loadList();
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
  sessionStorage.removeItem(PW_KEY);
  location.reload();
});
document.getElementById("add-variant").addEventListener("click", () => addVariantRow());
document.getElementById("course-form").addEventListener("submit", submitForm);
document.getElementById("cancel-edit").addEventListener("click", resetForm);

(async () => {
  if (pw && (await checkPw(pw))) showApp();
})();
