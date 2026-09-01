const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes)).map((v) => v.toString(16).padStart(2, "0")).join("");

export const KDF_ITERATIONS = 600_000;
export const VAULT_FORMAT = 2;

export type VaultKey = CryptoKey;

export type EncryptedVault = {
  format: 2;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

type LegacyEncryptedVault = {
  format: 1;
  salt: string;
  iv: string;
  ciphertext: string;
};

async function passwordMaterial(password: string, usage: KeyUsage[] = ["deriveBits", "deriveKey"]) {
  return crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, usage);
}

export async function authVerifier(username: string, password: string) {
  const base = await passwordMaterial(password, ["deriveBits"]);
  const salt = enc.encode(`food-coster-auth:${username.trim().toLowerCase()}`);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256" }, base, 256));
}

export async function hashVerifier(verifier: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

async function deriveVaultKeyWithIterations(password: string, salt: Uint8Array, iterations: number) {
  const base = await passwordMaterial(password, ["deriveKey"]);
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(salt);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuffer, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveVaultKey(password: string, saltText?: string) {
  const salt = saltText ? unb64(saltText) : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveVaultKeyWithIterations(password, salt, KDF_ITERATIONS);
  return { key, salt: b64(salt) };
}

export async function encryptCsvWithKey(csv: string, key: VaultKey, salt: string): Promise<EncryptedVault> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(csv));
  return {
    format: VAULT_FORMAT,
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    salt,
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ciphertext)),
  };
}

export async function decryptCsvWithKey(vault: EncryptedVault, key: VaultKey) {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) }, key, unb64(vault.ciphertext));
    return dec.decode(plain);
  } catch {
    throw new Error("암호가 올바르지 않거나 데이터가 손상되었습니다.");
  }
}

export async function unlockVault(vault: EncryptedVault | LegacyEncryptedVault, password: string) {
  if (vault.format === 2) {
    if (vault.kdf !== "PBKDF2-SHA256" || !Number.isInteger(vault.iterations) || vault.iterations < 1) throw new Error("지원하지 않는 암호화 설정입니다.");
    const key = await deriveVaultKeyWithIterations(password, unb64(vault.salt), vault.iterations);
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) }, key, unb64(vault.ciphertext));
      const csv = dec.decode(plain);
      if (vault.iterations === KDF_ITERATIONS) return { csv, key, salt: vault.salt, needsReencrypt: false };
      const upgraded = await deriveVaultKey(password);
      return { csv, key: upgraded.key, salt: upgraded.salt, needsReencrypt: true };
    } catch {
      throw new Error("암호가 올바르지 않거나 데이터가 손상되었습니다.");
    }
  }

  if (vault.format === 1) {
    const key = await deriveVaultKeyWithIterations(password, unb64(vault.salt), 210_000);
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) }, key, unb64(vault.ciphertext));
      const upgraded = await deriveVaultKey(password);
      return { csv: dec.decode(plain), key: upgraded.key, salt: upgraded.salt, needsReencrypt: true };
    } catch {
      throw new Error("암호가 올바르지 않거나 데이터가 손상되었습니다.");
    }
  }

  throw new Error("지원하지 않는 암호화 형식입니다.");
}

export async function makeInitialVault(csv: string, password: string) {
  const { key, salt } = await deriveVaultKey(password);
  return { key, salt, vault: await encryptCsvWithKey(csv, key, salt) };
}
