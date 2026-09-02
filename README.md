# Food Coster

점심·저녁 식대를 기록하고, 정산 기간별 사용액과 현재 사용할 수 있는 식대를 계산하는 모바일 우선 PWA입니다.

**웹사이트:** https://food-coster.mooner510.kr

서버는 식대 계산을 하지 않습니다. 식대 규칙, 정산 계산, CSV 변환, 암복호화는 모두 클라이언트에서 수행하며 서버에는 암호화된 vault만 저장합니다.

## 주요 기능

- 점심/저녁 식대 기록
- 정산 기간별 총액, 사용액, 현재 사용 가능액 계산
- 평일/토요일 포함/일요일 포함/매일 식대 제공 규칙
- 점심·저녁 미사용 식대의 당일 소멸 또는 누적 설정
- 저녁 식대 항상 제공 / 날짜별 제공 / 미제공 설정
- 날짜별 식대 제공 예외 설정
- 정산 기준일 1~31일 설정
- 한국 공휴일 제외 옵션
- 월간 달력에서 날짜별 식대 확인 및 수정
- 오프라인 사용
- 여러 기기 간 서버 동기화
- 암호화 백업 내보내기/복원
- PWA 설치
- 같은 기기 자동 로그인

---

## 기술 구조

### Client

- Next.js App Router
- React 19
- IndexedDB
- Web Crypto API
- Service Worker / PWA

클라이언트가 담당하는 작업:

- 식대 계산
- Ruleset 적용
- 정산 기간 계산
- CSV serialize / parse
- schema migration
- AES 암복호화
- IndexedDB 저장
- 서버/로컬 데이터 병합

### Server

서버 API는 `/api/vault` 하나를 중심으로 동작합니다.

서버가 담당하는 작업:

- Turso 자격증명 보호
- 회원가입/로그인 인증
- 세션 관리
- 암호화 vault CRUD
- revision 기반 동시성 제어
- rate limit

**식대 금액이나 정산 계산을 서버에서 처리하지 않습니다.**

### Database

Turso/libSQL을 사용합니다.

앱이 자동으로 관리하는 테이블:

- `food_coster_users`
- `food_coster_sessions`
- `food_coster_rate_limits`

첫 API 요청 시 `ensureSchema()`가 필요한 테이블과 컬럼을 idempotent하게 생성/보정합니다.

따라서 **새 DB를 만든 뒤 별도의 SQL migration을 수동 실행할 필요가 없습니다.**

---

## 최초 설정

### 1. Turso DB 생성

Turso에서 사용할 데이터베이스를 하나 생성합니다.

앱이 테이블 생성, INSERT, UPDATE, DELETE를 수행하므로 read-only가 아닌 **쓰기 가능한 auth token**이 필요합니다.

### 2. 환경 변수 설정

```env
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

로컬에서는 `.env.local`, 배포 환경에서는 Vercel Environment Variables 등에 등록합니다.

### 3. 설치 및 실행

```bash
pnpm install --frozen-lockfile
pnpm dev
```

기본 개발 서버는 Next.js 기본 주소에서 실행됩니다.

---

## 로컬 검증

전체 검증:

```bash
pnpm verify
```

실행 순서:

```text
lint
→ typecheck
→ test
→ build
```

각 명령은 다음과 같습니다.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

---

## GitHub Actions CI

`.github/workflows/verify.yml`에서 GitHub Actions 검증을 수행합니다.

트리거:

- 모든 branch의 `push`
- 모든 `pull_request`

실행 환경:

- `ubuntu-latest`
- Node.js 22
- pnpm 10.33.2
- timeout 15분

검증 순서:

```text
pnpm install --frozen-lockfile
→ pnpm lint
→ pnpm typecheck
→ pnpm test
→ pnpm build
```

같은 branch/ref에서 새 실행이 시작되면 이전 실행은 `concurrency.cancel-in-progress`로 취소합니다.

CI build에서는 실제 Turso에 연결하지 않고 placeholder 환경 변수를 사용합니다. 현재 build 과정 자체는 DB 요청을 수행하지 않습니다.

---

## Vercel 배포 정책

`vercel.json`에서 Git branch별 자동 배포를 제한합니다.

| Branch | Vercel 자동 배포 |
| --- | --- |
| `main` | 허용 |
| `dev` | 허용 |
| `feature/*` | 차단 |
| 그 외 모든 branch | 차단 |

현재 설정:

```json
{
  "git": {
    "deploymentEnabled": {
      "main": true,
      "dev": true,
      "*": false,
      "**": false
    }
  }
}
```

즉 feature branch를 push해도 GitHub Actions CI는 실행되지만 **Vercel Preview Deployment는 생성하지 않습니다.**

운영 웹사이트는 `https://food-coster.mooner510.kr`입니다.

---

## 로그인 및 로그인 유지

### 최초 로그인

사용자명과 암호를 입력하면 암호에서 다음 값을 파생합니다.

- 인증용 verifier
- vault 복호화용 AES key

암호 자체는 서버 DB에 저장하지 않습니다.

### 같은 기기 자동 로그인

최초 로그인/회원가입이 성공하면 같은 브라우저 또는 설치된 PWA에서는 일반적으로 다시 암호를 입력하지 않아도 됩니다.

로컬 IndexedDB에는 다음을 저장합니다.

- 암호화 vault
- `extractable: false`인 WebCrypto `CryptoKey`
- username
- revision 및 sync metadata

앱을 다시 실행하면 저장된 non-extractable key로 로컬 vault를 먼저 열어 UI를 표시합니다.

온라인 상태라면 이후 서버 세션을 확인하고 동기화를 진행합니다.

### 서버 세션

로그인 성공 시 서버가 256-bit random session token을 생성합니다.

브라우저:

- `HttpOnly`
- `SameSite=Strict`
- production에서 `Secure`

서버 DB:

- 원본 session token은 저장하지 않음
- SHA-256 hash만 저장

세션은 **90일 sliding expiration**을 사용하며 활동 중에는 만료가 연장됩니다.

### 로그아웃

로그아웃하면:

- 서버 세션 폐기
- remembered `CryptoKey` 제거
- 암호화된 로컬 vault 자체는 유지

다음 로그인 시 다시 키를 파생하여 사용할 수 있습니다.

### 암호 변경

암호 변경 시:

- 새로운 verifier 생성
- 새로운 AES key/salt로 vault 재암호화
- 기존 다른 기기의 세션 폐기
- 현재 기기 세션 재발급

---

## 암호화

vault는 다음 방식으로 보호합니다.

- AES-256-GCM
- PBKDF2-HMAC-SHA256
- 600,000 iterations
- 매 vault에 random salt / IV 사용

서버에 저장되는 데이터는 암호화된 vault이므로 서버 DB만으로 점심/저녁 금액이나 Ruleset의 평문을 확인할 수 없습니다.

### IndexedDB의 CryptoKey

자동 로그인을 위해 `extractable: false` CryptoKey를 IndexedDB에 저장합니다.

이 키는 `exportKey()`로 원문을 추출할 수 없습니다.

다만 동일 origin에서 실행되는 악성 JavaScript가 키를 직접 사용하려는 위협은 별개이므로:

- 외부 script 최소화
- CSP 적용
- 보안 응답 헤더 적용

을 유지합니다.

---

## 동기화 방식

### 로컬 저장

사용자가 식대나 설정을 변경하면 IndexedDB에는 즉시 암호화 저장합니다.

### 서버 저장

서버 동기화는 **마지막 변경 후 1,000ms 동안 추가 변경이 없을 때 한 번** 수행합니다.

예를 들어 금액 입력 중 값이 여러 번 바뀌더라도 각 키 입력마다 Turso에 요청하지 않고 마지막 입력이 끝난 뒤 1초 후 한 번 동기화합니다.

### 추가 동기화 시점

다음 상황에서도 동기화를 확인합니다.

- 로그인 직후
- 자동 로그인 직후
- 오프라인 → 온라인 복귀
- 앱/탭이 foreground로 복귀

**주기적인 polling은 하지 않습니다.**

### 충돌 처리

서버 vault에는 `revision`을 사용합니다.

push 시 클라이언트가 알고 있는 `baseRevision`과 서버 revision이 일치하는 경우에만 업데이트합니다.

충돌이 발생하면 서버/로컬 데이터를 다시 병합한 뒤 최신 revision 기준으로 재시도합니다.

현재 데이터 병합은 날짜별 Entry와 Ruleset의 `updatedAt`을 이용한 deterministic merge 방식입니다.

---

## 오프라인 동작

앱은 오프라인 우선 구조입니다.

오프라인에서도:

- 앱 실행
- 자동 로그인
- 식대 확인
- 기록 추가/수정
- 설정 수정

이 가능합니다.

변경 내용은 IndexedDB에 `pendingSync` 상태로 남으며 인터넷 연결이 복구되면 서버에 자동 반영됩니다.

Service Worker는 앱 shell과 Next 정적 asset을 캐시하며 `/api/*` 요청은 캐시하지 않습니다.

---

## Ruleset

식대 설정은 과거 기록을 일괄 덮어쓰지 않고 `effectiveFrom`을 가진 Ruleset으로 관리합니다.

주요 설정:

- 점심 식대
- 저녁 식대
- 식대 제공 요일
- 공휴일 제외
- 점심 carry 정책
- 저녁 제공 정책
- 저녁 carry 정책
- 정산 기준일

설정 화면에서는 기본적으로 **다음 정산 기간부터 적용**할 수 있으며 필요하면 현재 기간에 적용할 수 있습니다.

---

## CSV 및 schema migration

앱 데이터는 CSV로 직렬화할 수 있으며 schema version을 포함합니다.

이전 schema 형식이 로드되면 최신 schema로 migration합니다.

이를 통해 이전 버전의 로컬 데이터와 백업 파일을 가능한 범위에서 계속 읽을 수 있도록 구성합니다.

---

## 백업

설정 화면에서 암호화 백업을 내보낼 수 있습니다.

파일 형식:

```text
food-coster-YYYY-MM-DD.csv.enc
```

백업 파일은 생성 당시 암호로 암호화됩니다.

이후 계정 암호를 변경하더라도 기존 백업은 **백업 생성 당시 사용한 암호**로 복원합니다.

---

## 서버에 저장되는 정보

서버에 저장될 수 있는 정보:

- username
- verifier hash
- encrypted vault
- revision
- updated timestamp
- session token hash
- session expiry metadata
- rate limit metadata

서버에 저장하지 않는 정보:

- 원본 암호
- 원본 인증 verifier
- 원본 session token
- 점심/저녁 금액의 평문
- Ruleset 평문

---

## 주요 파일

```text
app/
  page.tsx                 UI / local state / sync orchestration
  api/vault/route.ts       auth / session / encrypted vault API
  manifest.ts              PWA manifest

lib/
  crypto.ts                PBKDF2 / AES-GCM / vault crypto
  model.ts                 식대 모델 / 계산 / CSV / migration
  storage.ts               IndexedDB
  sync.ts                  local/remote merge
  turso.ts                 Turso connection / schema initialization

public/
  sw.js                     Service Worker

.github/workflows/
  verify.yml                CI

vercel.json                 Vercel branch deployment policy
```

---

## 개발 원칙

- 식대/정산 business logic은 클라이언트에서 처리
- 서버에는 평문 식대 데이터를 저장하지 않음
- 사용자 입력은 로컬에 먼저 저장
- 서버 sync 실패가 로컬 기록 손실로 이어지지 않도록 함
- schema 변경 시 migration 경로 유지
- feature branch는 Vercel 배포하지 않음
- 변경 후 `pnpm verify` 기준으로 lint/type/test/build를 모두 통과시킬 것
