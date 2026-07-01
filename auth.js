// ────────────────────────────────────────────────────────────────
// 소셜 로그인 (카카오 · 네이버) — OAuth2 Authorization Code 플로우
//   - 세션 = HMAC 서명 쿠키 (서버 세션 저장소 불필요, 의존성 0)
//   - 유저 프로필은 store.readUsers / writeUsers (로컬 users.json / Lambda는 S3)
//   - 비밀(client secret)은 환경변수로만. git에 넣지 않는다.
//   라우트(server.js가 /auth/* 를 여기로 보냄):
//     GET  /auth/:provider/login     → 공급자 인증 페이지로 302
//     GET  /auth/:provider/callback  → 토큰 교환→프로필→세션쿠키→홈 302
//     GET  /auth/me                  → { user } (현재 세션)
//     POST /auth/logout              → 세션 쿠키 삭제
// ────────────────────────────────────────────────────────────────
const crypto = require("crypto");

const SESSION_SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "marathang-dev-secret";
const COOKIE = "mt_sess";
const STATE_COOKIE = "mt_oauth";
const SESSION_DAYS = 30;

const PROVIDERS = {
  kakao: {
    authUrl: "https://kauth.kakao.com/oauth/authorize",
    tokenUrl: "https://kauth.kakao.com/oauth/token",
    profileUrl: "https://kapi.kakao.com/v2/user/me",
    clientId: () => process.env.KAKAO_REST_KEY || "",
    clientSecret: () => process.env.KAKAO_CLIENT_SECRET || "",
    scope: "profile_nickname profile_image",
    parseProfile: (j) => {
      const acc = (j && j.kakao_account) || {};
      const pr = acc.profile || {};
      const props = (j && j.properties) || {};
      return {
        providerId: j && j.id != null ? String(j.id) : "",
        name: pr.nickname || props.nickname || "카카오 사용자",
        picture: pr.profile_image_url || props.profile_image || "",
      };
    },
  },
  naver: {
    authUrl: "https://nid.naver.com/oauth2.0/authorize",
    tokenUrl: "https://nid.naver.com/oauth2.0/token",
    profileUrl: "https://openapi.naver.com/v1/nid/me",
    clientId: () => process.env.NAVER_LOGIN_ID || "",
    clientSecret: () => process.env.NAVER_LOGIN_SECRET || "",
    scope: "",
    parseProfile: (j) => {
      const r = (j && j.response) || {};
      return { providerId: r.id ? String(r.id) : "", name: r.nickname || r.name || "네이버 사용자", picture: r.profile_image || "" };
    },
  },
};

function json(status, obj, setCookie) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return { statusCode: status, headers, body: JSON.stringify(obj) };
}
function redirect(to, setCookie) {
  const headers = { Location: to };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return { statusCode: 302, headers, body: "" };
}

// ── 쿠키 / 세션 서명 ──
function b64url(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlDecode(s) { return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"); }
function sign(data) { return b64url(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest()); }
function makeSession(payload) { const data = b64url(JSON.stringify(payload)); return data + "." + sign(data); }
function readSession(token) {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const data = token.slice(0, i), sig = token.slice(i + 1);
  const expected = sign(data);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { const p = JSON.parse(b64urlDecode(data)); if (p.exp && Date.now() > p.exp) return null; return p; } catch { return null; }
}
function parseCookies(h) {
  const out = {};
  (h || "").split(/;\s*/).forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); });
  return out;
}
function cookie(name, val, opts) {
  opts = opts || {};
  let s = name + "=" + encodeURIComponent(val) + "; Path=/; HttpOnly; SameSite=Lax";
  if (opts.secure) s += "; Secure";
  if (opts.maxAge != null) s += "; Max-Age=" + opts.maxAge;
  return s;
}
function baseUrl(headers) {
  const host = headers["x-forwarded-host"] || headers.host || "localhost:5500";
  const local = /^(localhost|127\.|0\.0\.0\.0)/.test(host);
  return (local ? "http" : "https") + "://" + host;
}

// 현재 세션 유저(없으면 null) — server.js가 다른 API에서 쓸 수 있게 export
function userFromHeaders(headers) {
  const h = {};
  for (const k in (headers || {})) h[k.toLowerCase()] = headers[k];
  return readSession(parseCookies(h.cookie)[COOKIE]);
}

async function handleAuth({ method, pathname, query, headers }, store) {
  const parts = pathname.split("/").filter(Boolean); // ["auth", provider?, action?]
  const cookies = parseCookies(headers.cookie);
  const secure = baseUrl(headers).startsWith("https://");

  if (pathname === "/auth/me") {
    const s = readSession(cookies[COOKIE]);
    return json(200, { user: s ? { id: s.uid, name: s.name, picture: s.picture, provider: s.provider } : null });
  }
  if (pathname === "/auth/logout") {
    const clear = cookie(COOKIE, "", { secure, maxAge: 0 });
    return method === "POST" ? json(200, { ok: true }, clear) : redirect(baseUrl(headers) + "/", clear);
  }

  const provider = parts[1], action = parts[2];
  const p = PROVIDERS[provider];
  if (!p) return json(404, { error: "unknown provider" });

  // 로그인 시작 → 공급자 인증 URL로
  if (action === "login") {
    const cid = p.clientId();
    if (!cid) return json(503, { error: provider + " 로그인이 아직 설정되지 않았어요(서버 환경변수 필요)" });
    const state = b64url(crypto.randomBytes(16));
    const redirectUri = baseUrl(headers) + "/auth/" + provider + "/callback";
    const u = new URL(p.authUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cid);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    if (p.scope) u.searchParams.set("scope", p.scope);
    return redirect(u.toString(), cookie(STATE_COOKIE, state, { secure, maxAge: 600 }));
  }

  // 콜백 → 토큰 교환 → 프로필 → 세션
  if (action === "callback") {
    const code = query.code, state = query.state;
    const home = baseUrl(headers) + "/";
    if (!code) return redirect(home + "?login_error=" + encodeURIComponent("인증 취소"));
    if (!state || state !== cookies[STATE_COOKIE]) return redirect(home + "?login_error=" + encodeURIComponent("state 불일치"));
    try {
      const redirectUri = baseUrl(headers) + "/auth/" + provider + "/callback";
      const form = new URLSearchParams({
        grant_type: "authorization_code", client_id: p.clientId(),
        client_secret: p.clientSecret(), redirect_uri: redirectUri, code, state,
      });
      const tokRes = await fetch(p.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
      const tok = await tokRes.json();
      if (!tok.access_token) return redirect(home + "?login_error=" + encodeURIComponent("토큰 발급 실패"));
      const profRes = await fetch(p.profileUrl, { headers: { Authorization: "Bearer " + tok.access_token } });
      const prof = p.parseProfile(await profRes.json());
      if (!prof.providerId) return redirect(home + "?login_error=" + encodeURIComponent("프로필 조회 실패"));

      const uid = provider + ":" + prof.providerId;
      const users = await store.readUsers();
      const now = Date.now();
      const existing = users[uid] || {};
      // 기존 유저 필드(북마크 등) 보존 + 프로필/lastLogin만 갱신.
      // (통째로 덮어쓰면 재로그인 때 favorites가 유실됨)
      users[uid] = {
        ...existing,
        id: uid, provider, providerId: prof.providerId, name: prof.name, picture: prof.picture,
        createdAt: existing.createdAt || now, lastLogin: now,
      };
      await store.writeUsers(users);

      const token = makeSession({ uid, provider, name: prof.name, picture: prof.picture, exp: now + SESSION_DAYS * 86400000 });
      return redirect(home, cookie(COOKIE, token, { secure, maxAge: SESSION_DAYS * 86400 }));
    } catch (e) {
      return redirect(home + "?login_error=" + encodeURIComponent("로그인 처리 오류"));
    }
  }

  return json(404, { error: "not found" });
}

module.exports = { handleAuth, userFromHeaders };
