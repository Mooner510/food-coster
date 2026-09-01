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

## 환경 변수

```env
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
```

테이블은 첫 API 요청에서 idempotent하게 생성·보정됩니다.

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

서버에는 사용자명, 인증 verifier hash, 암호화 vault, revision만 저장합니다. 점심/저녁 금액과 Ruleset의 평문은 서버에 저장하지 않습니다. 로컬 IndexedDB에도 동일한 암호화 vault를 저장합니다.

암호화 백업 파일은 `.csv.enc`로 내보내며 백업 생성 당시 암호로 복원할 수 있습니다.
