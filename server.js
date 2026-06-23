// ────────────────────────────────────────────────────────────────
// marathang 서버 코어
//   - 정적 파일 서빙 + /api/courses CRUD + /api/auth
//   - 데이터 저장소(store)는 갈아끼울 수 있음:
//       · 로컬 실행( node server.js ) → courses.json 파일
//       · Lambda( lambda.js )          → S3 객체 (setStore로 주입)
//   - handleRequest()는 전송수단에 독립적인 응답 객체를 반환 →
//       http 서버와 Lambda Function URL 양쪽에서 재사용
// ────────────────────────────────────────────────────────────────

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "courses.json");
const LOCKS_FILE = path.join(ROOT, "locks.json");
const FEEDBACK_FILE = path.join(ROOT, "feedback.json"); // 사용자 의견(제안/신고) — courses.json과 분리
const FEEDBACK_MAX = 1000; // 보관 상한 (오래된 건 잘림)
const VIEWS_FILE = path.join(ROOT, "views.json"); // 대회별 조회수 { eventId: count } — courses.json과 분리
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "marathangisspicy";
// 편집 락 TTL. 하트비트(클라가 주기적으로 갱신)가 끊기면 이만큼 뒤 자동 만료 →
// 탭을 그냥 닫아도 락이 영구히 박히지 않음.
const LOCK_TTL_MS = 90_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

// ── 데이터 저장소 (기본: courses.json 파일). lambda.js가 setStore로 S3로 교체 ──
const fileStore = {
  async read() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); }
    catch { return []; }
  },
  async write(list) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2) + "\n", "utf-8");
  },
  // 편집 락은 courses.json과 분리된 별도 파일에 저장 (코스 데이터 오염 방지)
  async readLocks() {
    try { return JSON.parse(fs.readFileSync(LOCKS_FILE, "utf-8")); }
    catch { return {}; }
  },
  async writeLocks(map) {
    fs.writeFileSync(LOCKS_FILE, JSON.stringify(map, null, 2) + "\n", "utf-8");
  },
  // 사용자 의견도 courses.json과 분리된 별도 파일
  async readFeedback() {
    try { return JSON.parse(fs.readFileSync(FEEDBACK_FILE, "utf-8")); }
    catch { return []; }
  },
  async writeFeedback(list) {
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(list, null, 2) + "\n", "utf-8");
  },
  // 대회별 조회수도 별도 파일
  async readViews() {
    try { return JSON.parse(fs.readFileSync(VIEWS_FILE, "utf-8")); }
    catch { return {}; }
  },
  async writeViews(map) {
    fs.writeFileSync(VIEWS_FILE, JSON.stringify(map, null, 2) + "\n", "utf-8");
  },
};
let store = fileStore;
function setStore(s) { store = s; }

// ── 유틸 ────────────────────────────────────────────────────────
function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "course") + "-" + Date.now().toString(36);
}
function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}

// ── 편집 락 ─────────────────────────────────────────────────────
// 만료된 락을 걸러낸 새 map 반환 (저장소를 읽을 때마다 청소)
function pruneLocks(map, now) {
  const out = {};
  for (const id in (map || {})) {
    if (map[id] && map[id].expires > now) out[id] = map[id];
  }
  return out;
}
// 현재 유효한 락 map을 읽어 만료분 정리까지 한 결과를 돌려줌
async function activeLocks() {
  const now = Date.now();
  const pruned = pruneLocks(await store.readLocks(), now);
  return pruned;
}
// id의 락이 owner의 것이 아니면 holder 정보를, 본인 것이거나 비어있으면 null
function lockBlocker(locks, id, owner) {
  const l = locks[id];
  if (l && l.owner !== owner) return l;
  return null;
}

// ── 사용자 의견(기능 제안 / 문제 신고) ──────────────────────────
// 들어온 의견을 검증·정규화. eventName은 서버가 courses에서 찾아 채움(클라 신뢰 X).
function normalizeFeedback(input, eventName, now) {
  const content = String((input && input.content) || "").trim();
  if (!content) throw new Error("내용을 입력하세요");
  const type = (input && input.type) === "bug" ? "bug" : "suggestion";
  return {
    id: "fb-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    type,
    content: content.slice(0, 2000),
    contact: String((input && input.contact) || "").trim().slice(0, 200),
    eventId: String((input && input.eventId) || "").trim().slice(0, 120),
    eventName: String(eventName || "").trim().slice(0, 120),
    status: "new",
    at: now,
  };
}

// 경로 좌표 정규화 → [[lat,lng], ...] (유효한 것만)
function cleanPath(p) {
  return (Array.isArray(p) ? p : [])
    .map((q) => [Number(q[0]), Number(q[1])])
    .filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
}
// 지점(waypoint) 타입 화이트리스트 — app.js/admin.js의 WP_TYPES와 일치
const WP_TYPES = ["start", "finish", "turn", "water", "km", "etc"];
// 지점 배열 정규화 → [{type,label,lat,lng}, ...] (유효한 좌표만)
function cleanWaypoints(w) {
  return (Array.isArray(w) ? w : [])
    .map((q) => ({
      type: q && WP_TYPES.includes(q.type) ? q.type : "etc",
      label: String((q && q.label) || "").trim().slice(0, 20),
      lat: Number(q && q.lat),
      lng: Number(q && q.lng),
    }))
    .filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lng));
}
// 거리별 코스(variant) 하나를 검증·정규화
function normalizeVariant(v) {
  const p = cleanPath(v && v.path);
  if (p.length < 2) throw new Error("거리별 코스의 path 좌표가 2개 미만");
  const start =
    Array.isArray(v.start) && v.start.length === 2
      ? [Number(v.start[0]), Number(v.start[1])]
      : p[0];
  return {
    distance: String((v && v.distance) || "").trim(),
    color: /^#[0-9a-fA-F]{6}$/.test(v && v.color) ? v.color : "#E8413A",
    start,
    path: p,
    waypoints: cleanWaypoints(v && v.waypoints),
  };
}
// 들어온 대회(event) 객체를 검증·정규화 (신모델 variants / 구모델 평면 둘 다)
function normalizeCourse(input) {
  if (!input || typeof input !== "object") throw new Error("invalid payload");
  const name = String(input.name || "").trim();
  if (!name) throw new Error("name 필수");

  let variants = Array.isArray(input.variants) ? input.variants : null;
  if (!variants) {
    variants = [{ distance: input.distance, color: input.color, start: input.start, path: input.path }];
  }
  variants = variants.map(normalizeVariant);
  if (!variants.length) throw new Error("variants가 비어 있음");

  const scaleNum = Number(input.scale);
  return {
    id: input.id ? String(input.id) : slugify(name),
    name,
    date: String(input.date || "").trim(),
    place: String(input.place || "").trim(),
    region: String(input.region || "").trim(),
    fee: String(input.fee || "").trim(),
    scale: Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : null,
    url: String(input.url || "#").trim() || "#",
    variants,
  };
}

// ── API 라우팅 (응답 객체 반환) ─────────────────────────────────
async function handleApi({ method, pathname, headers, body }) {
  const parts = pathname.split("/").filter(Boolean); // ["api","courses",":id?"]
  const id = decodeURIComponent(parts[2] || "");
  const isAuthed = (headers["x-admin-password"] || "") === ADMIN_PASSWORD;
  const owner = String(headers["x-edit-owner"] || "");

  // GET /api/auth → 비밀번호 확인
  if (parts[1] === "auth") return json(isAuthed ? 200 : 401, { ok: isAuthed });

  // GET /api/courses → 목록 (공개)
  if (method === "GET" && parts.length === 2 && parts[1] === "courses") return json(200, await store.read());

  // POST /api/feedback → 사용자 의견 접수 (공개, 비로그인). 인증 게이트보다 먼저 처리.
  if (parts[1] === "feedback" && method === "POST" && parts.length === 2) {
    try {
      const input = JSON.parse(body || "{}");
      let eventName = "";
      if (input && input.eventId) {
        const courses = await store.read();
        const c = courses.find((x) => x.id === String(input.eventId));
        if (c) eventName = c.name;
      }
      const item = normalizeFeedback(input, eventName, Date.now());
      const list = await store.readFeedback();
      list.unshift(item);
      await store.writeFeedback(list.slice(0, FEEDBACK_MAX));
      return json(201, { ok: true });
    } catch (e) { return json(400, { error: e.message }); }
  }

  // GET /api/views → 대회별 조회수 맵 (공개)
  if (parts[1] === "views" && method === "GET" && parts.length === 2)
    return json(200, await store.readViews());
  // POST /api/views/:id → 조회수 +1 (공개). 말풍선 열 때마다 호출.
  if (parts[1] === "views" && method === "POST" && id) {
    const views = await store.readViews();
    views[id] = (Number(views[id]) || 0) + 1;
    await store.writeViews(views);
    return json(200, { count: views[id] });
  }

  // 이하 쓰기 + 락 API는 비밀번호 필요
  if (!(method === "GET" && parts[1] === "courses") && !isAuthed)
    return json(401, { error: "비밀번호가 올바르지 않습니다." });

  // ── 편집 락 API (어드민 전용) ──────────────────────────────────
  // GET /api/locks → 현재 유효한 락 map
  if (parts[1] === "locks" && method === "GET" && parts.length === 2)
    return json(200, await activeLocks());
  // POST /api/locks/:id → 락 획득/갱신(하트비트). body { name }
  if (parts[1] === "locks" && method === "POST" && id) {
    if (!owner) return json(400, { error: "x-edit-owner 헤더 필요" });
    const locks = await activeLocks();
    const blocker = lockBlocker(locks, id, owner);
    if (blocker) return json(409, { error: "다른 사람이 편집 중", holder: blocker.name, expires: blocker.expires });
    let name = "";
    try { name = String((JSON.parse(body || "{}").name) || "").trim(); } catch {}
    const now = Date.now();
    locks[id] = { owner, name: name || (locks[id] && locks[id].name) || "", at: (locks[id] && locks[id].at) || now, expires: now + LOCK_TTL_MS };
    await store.writeLocks(locks);
    return json(200, { ok: true, lock: locks[id] });
  }
  // DELETE /api/locks/:id → 락 해제 (본인 것만)
  if (parts[1] === "locks" && method === "DELETE" && id) {
    const locks = await activeLocks();
    const l = locks[id];
    if (l && l.owner !== owner) return json(403, { error: "본인 락이 아님" });
    if (l) { delete locks[id]; await store.writeLocks(locks); }
    return json(200, { ok: true });
  }

  // ── 의견함 API (어드민 전용) ──────────────────────────────────
  // GET /api/feedback → 접수 목록 (최신순)
  if (parts[1] === "feedback" && method === "GET" && parts.length === 2)
    return json(200, await store.readFeedback());
  // PUT /api/feedback/:id → 상태 변경 { status: "new" | "done" }
  if (parts[1] === "feedback" && method === "PUT" && id) {
    const list = await store.readFeedback();
    const i = list.findIndex((f) => f.id === id);
    if (i === -1) return json(404, { error: "없는 의견" });
    let status = "new";
    try { status = JSON.parse(body || "{}").status === "done" ? "done" : "new"; } catch {}
    list[i].status = status;
    await store.writeFeedback(list);
    return json(200, list[i]);
  }
  // DELETE /api/feedback/:id → 삭제
  if (parts[1] === "feedback" && method === "DELETE" && id) {
    const list = await store.readFeedback();
    const next = list.filter((f) => f.id !== id);
    if (next.length === list.length) return json(404, { error: "없는 의견" });
    await store.writeFeedback(next);
    return json(200, { ok: true });
  }

  // POST /api/courses → 추가
  if (method === "POST" && parts.length === 2) {
    try {
      const course = normalizeCourse(JSON.parse(body || "{}"));
      const list = await store.read();
      if (list.some((c) => c.id === course.id)) course.id = slugify(course.name);
      list.push(course);
      await store.write(list);
      return json(201, course);
    } catch (e) { return json(400, { error: e.message }); }
  }
  // PUT /api/courses/:id → 수정
  if (method === "PUT" && id) {
    try {
      const locks = await activeLocks();
      const blocker = lockBlocker(locks, id, owner);
      if (blocker) return json(409, { error: (blocker.name || "다른 사람") + "님이 편집 중", holder: blocker.name });
      const list = await store.read();
      const i = list.findIndex((c) => c.id === id);
      if (i === -1) return json(404, { error: "코스 없음" });
      list[i] = normalizeCourse({ ...JSON.parse(body || "{}"), id });
      await store.write(list);
      if (locks[id]) { delete locks[id]; await store.writeLocks(locks); } // 저장 끝났으니 락 해제
      return json(200, list[i]);
    } catch (e) { return json(400, { error: e.message }); }
  }
  // DELETE /api/courses/:id → 삭제
  if (method === "DELETE" && id) {
    const locks = await activeLocks();
    const blocker = lockBlocker(locks, id, owner);
    if (blocker) return json(409, { error: (blocker.name || "다른 사람") + "님이 편집 중", holder: blocker.name });
    const list = await store.read();
    const next = list.filter((c) => c.id !== id);
    if (next.length === list.length) return json(404, { error: "코스 없음" });
    await store.write(next);
    if (locks[id]) { delete locks[id]; await store.writeLocks(locks); }
    return json(200, { ok: true });
  }
  return json(404, { error: "not found" });
}

// ── 정적 파일 서빙 (응답 객체 반환) ─────────────────────────────
function serveStatic(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/admin" || rel === "/admin/") rel = "/admin.html";
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    return { statusCode: 403, headers: { "Content-Type": "text/plain" }, body: "forbidden" };
  }
  try {
    const buf = fs.readFileSync(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    return { statusCode: 200, headers: { "Content-Type": type }, body: buf.toString("utf-8") };
  } catch {
    return { statusCode: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "404 Not Found" };
  }
}

// ── 코어: 요청 1건 → 응답 객체 ─────────────────────────────────
async function handleRequest({ method, pathname, headers, body }) {
  const h = {};
  for (const k in (headers || {})) h[k.toLowerCase()] = headers[k];
  if (pathname.startsWith("/api/")) return handleApi({ method, pathname, headers: h, body });
  return serveStatic(pathname);
}

module.exports = { handleRequest, setStore };

// ── 로컬 실행일 때만 http 서버 기동 ────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 5500;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let body = "";
      if (req.method !== "GET" && req.method !== "HEAD") {
        body = await new Promise((resolve, reject) => {
          let d = "";
          req.on("data", (c) => { d += c; if (d.length > 5_000_000) reject(new Error("body too large")); });
          req.on("end", () => resolve(d));
          req.on("error", reject);
        });
      }
      const r = await handleRequest({ method: req.method, pathname: url.pathname, headers: req.headers, body });
      res.writeHead(r.statusCode, r.headers);
      res.end(r.body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(PORT, () => {
    console.log("marathang 서버 실행 → http://localhost:" + PORT);
    console.log("  · 메인 지도 : http://localhost:" + PORT + "/");
    console.log("  · 어드민    : http://localhost:" + PORT + "/admin");
  });
}
