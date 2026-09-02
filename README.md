# Food Coster

점심·저녁 식대를 기록하고 정산 기간별 사용 가능액을 계산하는 모바일 우선 PWA입니다.

## 구조

- Next.js App Router
- 식대 계산·Ruleset·CSV migration·암복호화: 클라이언트
- IndexedDB: 오프라인 우선 암호화 vault 캐시
- Turso: 사용자별 암호화 vault 영구 저장
- `/api/vault`: Turso 자격증명을 숨기기 위한 저장/동기화 전용 API
- AES-256-GCM + PBKDF2-SHA256 600,000 iterations
- CSV schema version 기반 순차 migration
- revision 기반 다중 기기 동기화 + 날짜별/Ruleset별 `updatedAt` 자동 병합

## 로그인 유지

최초 로그인 또는 회원가입 후 같은 브라우저/PWA에서는 다시 암호를 입력하지 않아도 됩니다.

- 서버 인증: 256-bit 랜덤 세션 토큰의 SHA-256 hash만 Turso에 저장
- 브라우저 인증: `HttpOnly`, `SameSite=Strict`, production `Secure` 쿠키
- 세션: 90일 sliding expiration, 활동 중에는 하루 단위로 만료 연장
- 로컬 잠금 해제: `extractable: false`인 WebCrypto `CryptoKey`를 IndexedDB에 저장
- 앱 시작: 로컬 암호화 vault를 즉시 열고, 온라인이면 세션 쿠키로 백그라운드 동기화
- 오프라인: 서버 없이 로컬 vault로 바로 사용
- 로그아웃/세션 만료: 로컬 remembered key 제거, 암호화 vault 자체는 유지
- 암호 변경: 다른 기기의 기존 서버 세션을 모두 폐기하고 현재 기기 세션만 재발급

기존 버전에서 업데이트한 사용자는 한 번 로그인하면 remembered key와 쿠키 세션이 생성됩니다.

## 동기화

입력은 IndexedDB에 즉시 암호화 저장합니다. 서버 동기화는 마지막 변경 후 **1초** 동안 추가 변경이 없을 때 한 번 수행합니다.

또한 다음 시점에 동기화를 확인합니다.

- 오프라인에서 온라인으로 복귀
- 앱/탭이 다시 foreground로 복귀
- 로그인/자동 로그인 직후

고정 주기 polling은 하지 않습니다.

## 환경 변수

```env
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
```

테이블은 첫 API 요청에서 idempotent하게 생성·보정됩니다. `food_coster_users`, `food_coster_sessions`, `food_coster_rate_limits`를 앱이 자동 생성하므로 별도 migration SQL 실행은 필요하지 않습니다.

## 실행

```bash
pnpm install --frozen-lockfile
pnpm dev
```

검증:

```bash
pnpm verify
```

GitHub Actions에서도 `install → lint → typecheck → test → build` 순서로 검증합니다.

## 데이터 원칙

서버에는 사용자명, 인증 verifier hash, 암호화 vault, revision과 세션 token hash만 저장합니다. 점심/저녁 금액과 Ruleset의 평문, 사용자의 원본 암호, 원본 세션 토큰은 서버 DB에 저장하지 않습니다.

로컬 IndexedDB에는 암호화 vault와 자동 로그인을 위한 non-extractable `CryptoKey`가 저장됩니다. 키는 JavaScript에서 원문으로 export할 수 없지만, 동일 origin에서 실행되는 코드가 키 사용을 요청할 수 있으므로 외부 스크립트를 두지 않고 CSP/보안 헤더를 적용합니다.

암호화 백업 파일은 `.csv.enc`로 내보내며 백업 생성 당시 암호로 복원할 수 있습니다.
