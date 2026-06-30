# 실제 배포된 AWS 리소스

> SAM CLI가 없어 **AWS CLI로 직접** 배포. 구조: 단일 Lambda가 정적+API 처리, 데이터는 S3, 앞단은 API Gateway(HTTP API).
> 프로필 `marathang` 사용( `~/.aws/credentials` ).

- **계정**: 574748894595 (IAM user `marathang`) / 리전: ap-northeast-2 (서울)
- **접속 주소(라이브)**:
  - 사이트  : https://m6osvmjoo5.execute-api.ap-northeast-2.amazonaws.com
  - 어드민  : https://m6osvmjoo5.execute-api.ap-northeast-2.amazonaws.com/admin
- **어드민 비밀번호**: marathangisspicy (Lambda 환경변수 `ADMIN_PASSWORD`)

## 리소스
| 종류 | 이름/ID |
|---|---|
| Lambda 함수 | `marathang` (nodejs20.x, handler `lambda.handler`) |
| IAM 역할 | `marathang-lambda-role` (+ 인라인 `marathang-s3`, 관리형 BasicExecution) |
| S3 버킷(데이터) | `marathang-data-574748894595` (객체 `courses.json`) |
| API Gateway | HTTP API `m6osvmjoo5` ($default → Lambda 프록시) |

## 코드 갱신 시 (재배포)
```bash
powershell Compress-Archive -Path lambda.js,server.js,auth.js,index.html,app.js,style.css,data.js,admin.html,admin.js,admin.css,regions.json,courses.json -DestinationPath _function.zip -Force
aws lambda update-function-code --function-name marathang --zip-file fileb://_function.zip --region ap-northeast-2 --profile marathang
```

## 비밀번호 변경
```bash
aws lambda update-function-configuration --function-name marathang --region ap-northeast-2 --profile marathang \
  --environment "Variables={COURSES_BUCKET=marathang-data-574748894595,COURSES_KEY=courses.json,ADMIN_PASSWORD=새비밀번호}"
```

## 전체 삭제 (teardown)
```bash
aws apigatewayv2 delete-api --api-id m6osvmjoo5 --region ap-northeast-2 --profile marathang
aws lambda delete-function --function-name marathang --region ap-northeast-2 --profile marathang
aws iam delete-role-policy --role-name marathang-lambda-role --policy-name marathang-s3 --profile marathang
aws iam detach-role-policy --role-name marathang-lambda-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole --profile marathang
aws iam delete-role --role-name marathang-lambda-role --profile marathang
aws s3 rm s3://marathang-data-574748894595 --recursive --profile marathang
aws s3api delete-bucket --bucket marathang-data-574748894595 --region ap-northeast-2 --profile marathang
```

## CI/CD (GitHub Actions)
- 저장소: https://github.com/softwareDefine/marathang (private)
- `.github/workflows/deploy.yml` — **`main` 푸시 시** 문법검사 → `aws lambda update-function-code` → 스모크 테스트
- 인증: GitHub Secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (계정 574748894595의 `marathang` 키)
- 문서/`template.yaml`/csv만 바뀐 커밋은 배포 생략(`paths-ignore`)
- 데이터(`courses.json`)는 S3가 source of truth — 코드 배포와 무관(어드민이 S3에 직접 씀)

## ⚠️ 남은 1가지 (사용자가 해야 함)
네이버 콘솔 → Maps 인증정보 → **[Web 서비스 URL]** 에 추가해야 지도 타일이 뜸:
```
https://m6osvmjoo5.execute-api.ap-northeast-2.amazonaws.com
```
