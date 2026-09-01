import assert from "node:assert/strict";
import test from "node:test";
import { decryptCsvWithKey, encryptCsvWithKey, makeInitialVault, unlockVault } from "../lib/crypto";

test("vault는 암호화 후 같은 키로 원문을 복원한다", async () => {
  const csv = "# food-coster-schema,2\nkind,key,a";
  const created = await makeInitialVault(csv, "correct-horse-battery-staple");
  assert.notEqual(created.vault.ciphertext, csv);
  assert.equal(await decryptCsvWithKey(created.vault, created.key), csv);
});

test("vault는 백업 당시 암호로 다시 열 수 있다", async () => {
  const csv = "# food-coster-schema,2\nkind,key,a";
  const created = await makeInitialVault(csv, "backup-password-123");
  const unlocked = await unlockVault(created.vault, "backup-password-123");
  assert.equal(unlocked.csv, csv);
});

test("잘못된 암호로는 vault를 열 수 없다", async () => {
  const created = await makeInitialVault("secret", "right-password");
  await assert.rejects(() => unlockVault(created.vault, "wrong-password"), /암호가 올바르지 않거나 데이터가 손상되었습니다/);
});

test("같은 데이터도 매 암호화마다 IV가 달라 암호문이 달라진다", async () => {
  const created = await makeInitialVault("same", "password-1234");
  const second = await encryptCsvWithKey("same", created.key, created.salt);
  assert.notEqual(created.vault.iv, second.iv);
  assert.notEqual(created.vault.ciphertext, second.ciphertext);
});
