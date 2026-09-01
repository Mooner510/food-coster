const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes)).map(v => v.toString(16).padStart(2,"0")).join("");

async function pbkdf2(password: string, salt: Uint8Array, usage: KeyUsage[]) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, usage);
}

export async function authVerifier(username: string, password: string) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = enc.encode(`food-coster-auth:${username.trim().toLowerCase()}`);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, base, 256));
}

export async function hashVerifier(verifier: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

export type EncryptedVault = { format: 1; salt: string; iv: string; ciphertext: string };

export async function encryptCsv(csv: string, password: string, existingSalt?: string): Promise<EncryptedVault> {
  const salt = existingSalt ? unb64(existingSalt) : crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pbkdf2(password, salt, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(csv));
  return { format: 1, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}

export async function decryptCsv(vault: EncryptedVault, password: string) {
  if (vault.format !== 1) throw new Error("지원하지 않는 암호화 형식입니다.");
  const salt = unb64(vault.salt);
  const iv = unb64(vault.iv);
  const key = await pbkdf2(password, salt, ["decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, unb64(vault.ciphertext));
    return dec.decode(plain);
  } catch {
    throw new Error("암호가 올바르지 않거나 데이터가 손상되었습니다.");
  }
}
