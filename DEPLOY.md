# AWS 배포 (Lambda + Function URL + S3) — SAM

기존 `server.js`를 Lambda에서 그대로 돌리고, 데이터(`courses.json`)만 S3에 저장한다.
정적파일·API 모두 **단일 Lambda**가 처리하고 **Function URL** 하나로 접속한다.

## 0. 준비물 (한 번만)

- AWS 계정
- **AWS CLI** 설치 + 자격증명 등록: `aws configure` (Access Key / Secret / 리전)
  - 리전은 서울 `ap-northeast-2` 권장 (지도 응답 빠름)
- **AWS SAM CLI** 설치: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html

## 1. 배포

프로젝트 폴더에서:

```bash
sam deploy --guided
```

프롬프트 응답 예시:
- Stack Name: `marathang`
- AWS Region: `ap-northeast-2`
- Parameter AdminPassword: 원하는 어드민 비밀번호
- Confirm changes before deploy: `N` (또는 Y로 확인)
- Allow SAM CLI IAM role creation: `Y`
- **MarathangFunction Function URL may not have authorization defined, Is this okay?: `Y`** (공개 사이트라 의도된 것)
- Save arguments to configuration file: `Y` (다음엔 `sam deploy`만 하면 됨)

끝나면 Outputs에 주소가 찍힌다:
- `SiteUrl`  = `https://xxxxxxxx.lambda-url.ap-northeast-2.on.aws/`
- `AdminUrl` = `.../admin`
- `Bucket`   = 코스 데이터 저장 버킷 이름

## 2. ⚠️ 네이버 지도 도메인 등록 (안 하면 지도 안 뜸)

네이버 클라우드 콘솔 → Maps 인증정보 → **[Web 서비스 URL]** 에
위 `SiteUrl` 도메인(`https://xxxxxxxx.lambda-url.ap-northeast-2.on.aws`)을 추가한다.
(이게 없으면 SDK가 도메인 인증 실패로 타일을 안 그림 — 로컬 `localhost:5500`과 동일한 이슈)

## 3. (선택) 기존 코스 데이터 미리 올리기

S3에 `courses.json`이 아직 없으면 패키지에 번들된 시드가 쓰인다.
지금 로컬 데이터를 그대로 올리려면:

```bash
aws s3 cp courses.json s3://<Bucket이름>/courses.json
```

어드민에서 추가/수정/삭제하면 이 S3 객체가 갱신된다.

## 4. 다시 배포 / 비밀번호 변경

```bash
sam deploy                                   # 코드 수정 후 재배포
sam deploy --parameter-overrides AdminPassword=새비밀번호
```

## 5. 내리기

```bash
sam delete
```
(S3 버킷에 객체가 있으면 먼저 비워야 삭제됨: `aws s3 rm s3://<Bucket>/courses.json`)

## 비용 (대략)

- **Lambda**: 호출 횟수 + 실행시간(GB-초) 기준. 월 100만 호출·40만 GB-초까지 **프리티어 무료**.
  이 사이트 트래픽이면 사실상 $0 ~ 몇 센트.
- **S3**: 저장용량(courses.json은 수십 KB → 거의 0) + 요청 횟수(GET/PUT) 기준. 역시 사실상 $0.
- **Function URL**: 추가 비용 없음(API Gateway 안 씀).
- 트래픽 폭증만 없으면 월 몇 백 원 이하. 단, 프리티어 종료(가입 12개월 후) 후엔 소액 과금 가능.
