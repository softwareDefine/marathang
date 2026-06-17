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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "marathangisspicy";

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

// 경로 좌표 정규화 → [[lat,lng], ...] (유효한 것만)
function cleanPath(p) {
  return (Array.isArray(p) ? p : [])
    .map((q) => [Number(q[0]), Number(q[1])])
    .filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
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

  return {
    id: input.id ? String(input.id) : slugify(name),
    name,
    date: String(input.date || "").trim(),
    place: String(input.place || "").trim(),
    fee: String(input.fee || "").trim(),
    url: String(input.url || "#").trim() || "#",
    variants,
  };
}

// ── API 라우팅 (응답 객체 반환) ─────────────────────────────────
async function handleApi({ method, pathname, headers, body }) {
  const parts = pathname.split("/").filter(Boolean); // ["api","courses",":id?"]
  const id = decodeURIComponent(parts[2] || "");
  const isAuthed = (headers["x-admin-password"] || "") === ADMIN_PASSWORD;

  // GET /api/auth → 비밀번호 확인
  if (parts[1] === "auth") return json(isAuthed ? 200 : 401, { ok: isAuthed });

  // GET /api/courses → 목록 (공개)
  if (method === "GET" && parts.length === 2) return json(200, await store.read());

  // 이하 쓰기는 비밀번호 필요
  if (method !== "GET" && !isAuthed) return json(401, { error: "비밀번호가 올바르지 않습니다." });

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
      const list = await store.read();
      const i = list.findIndex((c) => c.id === id);
      if (i === -1) return json(404, { error: "코스 없음" });
      list[i] = normalizeCourse({ ...JSON.parse(body || "{}"), id });
      await store.write(list);
      return json(200, list[i]);
    } catch (e) { return json(400, { error: e.message }); }
  }
  // DELETE /api/courses/:id → 삭제
  if (method === "DELETE" && id) {
    const list = await store.read();
    const next = list.filter((c) => c.id !== id);
    if (next.length === list.length) return json(404, { error: "코스 없음" });
    await store.write(next);
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
