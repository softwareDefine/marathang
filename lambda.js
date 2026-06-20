// ────────────────────────────────────────────────────────────────
// AWS Lambda 핸들러 (Function URL, payload format 2.0)
//   - server.js의 handleRequest를 그대로 재사용
//   - 데이터 저장소만 S3로 교체 (Lambda는 로컬 파일 쓰기 불가)
//   - 정적 파일은 Lambda 패키지에서 읽어 서빙
// @aws-sdk/client-s3 는 nodejs20.x 런타임에 기본 포함 → 별도 설치 불필요
// ────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const { handleRequest, setStore } = require("./server.js");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const BUCKET = process.env.COURSES_BUCKET;
const KEY = process.env.COURSES_KEY || "courses.json";
const LOCKS_KEY = process.env.LOCKS_KEY || "locks.json"; // 편집 락 (courses.json과 분리)
const s3 = new S3Client({});

async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf-8");
}

// S3 한 객체에 courses.json 통째로 저장
const s3Store = {
  async read() {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
      return JSON.parse(await streamToString(out.Body));
    } catch (e) {
      // 최초 호출 등 객체가 아직 없으면 → 패키지에 번들된 courses.json을 시드로
      if (e.name === "NoSuchKey" || (e.$metadata && e.$metadata.httpStatusCode === 404)) {
        try { return JSON.parse(fs.readFileSync(path.join(__dirname, "courses.json"), "utf-8")); }
        catch { return []; }
      }
      throw e;
    }
  },
  async write(list) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: KEY,
      Body: JSON.stringify(list, null, 2) + "\n",
      ContentType: "application/json; charset=utf-8",
    }));
  },
  // 편집 락은 별도 S3 키. 없으면 빈 map (courses.json은 절대 안 건드림)
  async readLocks() {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: LOCKS_KEY }));
      return JSON.parse(await streamToString(out.Body));
    } catch (e) {
      // 객체가 아직 없으면 빈 락맵(=락 없음). 단, 역할에 s3:ListBucket이 없으면
      // S3가 "없는 키"에 404가 아니라 403(AccessDenied)을 주므로 그 경우도 빈 맵으로 처리한다.
      // (locks.json은 첫 쓰기 때 PutObject로 생성되고, 그 뒤 GET은 200이 됨)
      const code = e.$metadata && e.$metadata.httpStatusCode;
      if (e.name === "NoSuchKey" || e.name === "NotFound" || e.name === "AccessDenied" || code === 404 || code === 403) return {};
      throw e;
    }
  },
  async writeLocks(map) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: LOCKS_KEY,
      Body: JSON.stringify(map, null, 2) + "\n",
      ContentType: "application/json; charset=utf-8",
    }));
  },
};
setStore(s3Store);

exports.handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || "GET";
  const pathname = event.rawPath || "/";
  const headers = event.headers || {};
  let body = event.body || "";
  if (event.isBase64Encoded && body) body = Buffer.from(body, "base64").toString("utf-8");

  const r = await handleRequest({ method, pathname, headers, body });
  return {
    statusCode: r.statusCode,
    headers: r.headers,
    body: r.body,
    isBase64Encoded: false,
  };
};
