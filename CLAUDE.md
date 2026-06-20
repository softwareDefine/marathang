# marathang — 2026 마라톤 코스 지도

전국(현재는 서울권) 마라톤 코스를 한 네이버 지도 위에 겹쳐 보여주는 정적 웹 페이지.
풀스크린 지도 + 떠 있는 UI 패널 구성.

## 실행

코스 추가/삭제(어드민)를 쓰려면 **Node 서버**로 띄운다 (의존성 없음):

```bash
node server.js
```

→ 메인 지도 `http://localhost:5500/` · 어드민 `http://localhost:5500/admin` (`/admin` → `admin.html` 라우팅)

읽기 전용으로 지도만 볼 거면 정적 서버로도 충분 (이땐 `/api/courses` 404 → `data.js` 폴백):

```bash
python -m http.server 5500
```

네이버 클라우드 콘솔 [Web 서비스 URL]에 `http://localhost:5500`, `http://127.0.0.1:5500` 등록돼 있어야 타일이 로드됨. (`file://`에선 도메인 인증 문제로 안 뜸)

## 파일 구조

- `index.html` — 마크업. 풀스크린 지도(`#map`) + 떠 있는 패널들(로고/검색/사이드바/컨트롤)
- `style.css` — 전부 CSS 변수 기반. 다크/라이트 테마는 `:root` / `:root[data-theme="light"]`
- `app.js` — 네이버 지도 초기화, 코스 오버레이, 사이드바, 검색, 테마, 지도 컨트롤, 거리재기/거리뷰. 부팅 시 `/api/courses`를 먼저 fetch해 `COURSES`를 덮어씀(실패 시 `data.js` 폴백)
- `data.js` — `COURSES` 폴백 시드 (서버 없이 띄울 때만 사용). `let COURSES`라 app.js가 재할당 가능. 구(평면)·신(variants) 구조 둘 다 가능 — app.js `normalizeEvents`가 흡수
- `courses.json` — **실제 데이터 소스** (서버가 읽고 씀). 어드민으로 추가/수정/삭제하면 여기 반영
- `server.js` — 서버 코어. `handleRequest()`가 전송수단 독립적 응답객체 반환(로컬 http + Lambda 공용). 데이터 저장소(`store`)는 주입식: 로컬은 `courses.json` 파일, Lambda는 S3. `require.main===module`일 때만 http 서버 기동. 비밀번호는 `process.env.ADMIN_PASSWORD`(기본 `marathangisspicy`)
- `lambda.js` — AWS Lambda Function URL 핸들러. `server.js`의 `handleRequest` 재사용, `setStore`로 S3 저장소 주입. `@aws-sdk/client-s3`는 nodejs20.x 런타임 기본 포함
- `template.yaml` — AWS SAM. Lambda(Function URL) + 비공개 S3 버킷(코스 데이터). `DEPLOY.md`에 배포 절차
- `DEPLOY.md` — `sam deploy --guided` 배포 가이드. **Function URL 도메인을 네이버 [Web 서비스 URL]에 등록해야 지도가 뜸**
- `admin.html` / `admin.js` / `admin.css` — 어드민 페이지. 로그인 → 마라톤 폼 + GPX 업로드 → 코스 추가/삭제
- `marathons_2026_with_participants.csv` — 원본 데이터 (코드에서 직접 안 씀)

## 네이버 지도 키

`app.js` 상단 `NAVER_CLIENT_ID`. 신규 콘솔 키는 `ncpKeyId` 파라미터 사용 (SDK URL에 반영됨).
SDK는 `submodules=panorama`로 로드 — 거리뷰(파노라마) 기능 때문.

## 기능

- **코스 오버레이** — `data.js`의 각 코스를 색깔 폴리라인 + 출발 마커로 표시. 마커 클릭 시 정보 말풍선(InfoWindow)
- **사이드바 코스 목록** — 카드별 토글 스위치(코스 색)로 지도 표시 on/off, 카드 클릭 시 해당 코스로 이동
- **검색** — 코스 이름/장소/거리로 실시간 필터 (사이드바 + 지도 동시)
- **테마** — 다크/라이트 토글(로고 오른쪽 해/달 아이콘). localStorage 기억. 다크일 때 지도 일반 타일도 CSS 필터로 어둡게
- **지도 컨트롤** — 네이버 기본 컨트롤은 끄고 커스텀 UI로 통일: [일반|위성] 세그먼트, 줌 +/−
- **거리재기** — 지도 클릭으로 점 찍어 누적 거리(Haversine 직접 계산) 측정
- **거리뷰** — 지도 클릭 위치의 네이버 파노라마를 우하단 패널에 표시. 켜져 있는 코스 경로를 파노라마 바닥에 점(마커)으로 깔고, 카메라를 경로 진행 방향으로 회전 (네이버 파노라마는 폴리라인 미지원 → 보간한 점으로 표현)
- **어드민** (`/admin`) — 비밀번호 로그인 후 마라톤 추가/수정/삭제. 한 대회에 **거리별 코스(variant) 여러 개**를 등록, 각 거리는 **GPX 업로드 또는 에디터 지도에서 직접 클릭으로 그리기** 중 선택. GPX는 브라우저에서 파싱·솎아내(`downsample`) `path`로 변환, 그리기는 지도 클릭 좌표를 `path`에 적립 → 서버에 JSON 전송 (multipart 안 씀 → 서버 의존성 0). 수정 시 각 variant의 기존 `path`를 그대로 불러와 두므로 안 건드린 거리는 유지(PUT). 에디터 지도는 0높이로 생성될 수 있어 `resize`+`fitBounds`를 setTimeout으로 다시 호출

거리재기/거리뷰는 둘 다 지도 클릭을 쓰므로 한 번에 하나만 활성(`setupTools`에서 배타 처리).

## 디자인 규칙

- **장식 이모지 금지.** 모든 아이콘은 인라인 SVG (돋보기, 해/달). 텍스트는 담백하게, 과잉 친절 안내문 배제.
- 폰트: 네이버 나눔스퀘어Neo (`hangeul.pstatic.net` CSS). 가변폰트(`NanumSquareNeoVariable`)는 로드 에러라 **굵기별 패밀리**로 매핑 (`NanumSquareNeo`=본문, `NanumSquareNeoBold`=제목/코스명, `NanumSquareNeoHeavy`=로고).
- 색은 전부 CSS 변수. 떠 있는 패널은 `--float-bg`(반투명+blur), `--float-shadow` 공용.

## 함정 (반복해서 물린 것)

- **`[hidden]` + `display:flex/grid` 충돌** — HTML `hidden` 속성은 `display:none`이지만, CSS에서 `display:flex` 등을 주면 `hidden`을 덮어써서 안 숨겨짐. `.map-fallback`, `.course-item`, `.dist-readout`, 어드민 `.login`·`.vrow__draw`에서 각각 `[hidden] { display: none; }` 명시로 해결. 새 요소 숨길 때 주의.
- **`bounds.isEmpty()` 없음** — 신규 네이버 SDK엔 `LatLngBounds.isEmpty()`가 없어 throw됨. `if (COURSES.length)`로 대체.
- **다크 지도 필터가 위성/오버레이 반전** — 다크 타일 필터는 `img[src*="/styles/basic/"]`로 좁혀서 일반 지도 타일에만 적용. 위성사진·마커·코스선·말풍선은 색 유지.
- 모든 떠 있는 패널 색은 테마 변수로 빼야 라이트/다크 둘 다 정상.

## 데이터 메모

**데이터 모델 (신):** `courses.json` = 대회(event) 배열. 각 대회는
`{ id, name, date, place, fee, url, variants: [{ distance, color, start, path }] }`.
즉 **대회 1개가 거리별 코스(variant) 여러 개**를 가짐(5km/10km/하프/풀 각자 색·경로). app.js는 로드 시 `normalizeEvents`로 정규화하고 variant마다 `vid = eventId + "#" + index`를 부여해 오버레이/사이드바 토글 키로 씀. 구(평면 `path/distance/color`) 구조도 variant 1개로 자동 변환돼 호환.

좌표가 공식 GPX가 아니면 출발지·거리 기반 **추정 경로**. 공식 경로는 어드민에서 거리별로 GPX 업로드(또는 지도에서 직접 그리기)하면 `courses.json`에 저장됨.

서버를 띄우면 **`courses.json`이 source of truth**, `data.js`는 폴백 시드라 둘이 drift할 수 있음. `courses.backup.json`은 지난 대회 삭제 전 백업.

## AWS 계정 / IAM

> ⚠️ **비밀(액세스 키/시크릿/비밀번호)은 여기에 적지 않는다.** 자격증명은 `~/.aws`에만 두고 git에 커밋 금지. 이 절은 어느 계정에 무엇이 있는지 식별용 메모.

- **이 머신 기본 자격증명** — 계정 `603571288857`, IAM 유저 `adminUser` (`arn:aws:iam::603571288857:user/adminUser`, 생성 2026-05-17), 리전 `ap-northeast-2`. 인증은 비밀번호가 아니라 **액세스 키**(CLI)로 함.
- **실제 marathang 배포 계정은 `574748894595`** — 머신 기본값(603571288857)과 다름. **S3/Lambda 등 배포·데이터 작업 전에 `aws sts get-caller-identity`로 계정부터 확인할 것.** (라이브 S3 `courses.json`은 명시적 승인 없이 덮어쓰지 않기)
- IAM 유저 **로그인 비밀번호는 AWS가 평문 조회 불가**(단방향 해시). 모를 땐 `aws iam update-login-profile`로 재설정만 가능. CLI 작업엔 비밀번호 불필요.
