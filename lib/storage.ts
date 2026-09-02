import type { EncryptedVault, VaultKey } from "./crypto";

export type LocalVault = {
  username: string;
  verifierHash: string;
  vault: EncryptedVault;
  serverRevision: number;
  localModifiedAt: number;
  pendingSync: boolean;
  vaultKey?: VaultKey;
  salt?: string;
  remembered?: boolean;
  lastUsedAt?: number;
};

const DB = "food-coster";
const STORE = "vaults";
const VERSION = 2;

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB, VERSION);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "username" });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function normalizeLocal(value: Partial<LocalVault> & { updatedAt?: number }, fallbackUsername: string): LocalVault {
  return {
    username: String(value.username ?? fallbackUsername),
    verifierHash: String(value.verifierHash ?? ""),
    vault: value.vault as EncryptedVault,
    serverRevision: Math.max(0, Number(value.serverRevision ?? 0)),
    localModifiedAt: Math.max(0, Number(value.localModifiedAt ?? value.updatedAt ?? 0)),
    pendingSync: Boolean(value.pendingSync),
    vaultKey: value.vaultKey,
    salt: typeof value.salt === "string" ? value.salt : undefined,
    remembered: Boolean(value.remembered),
    lastUsedAt: Math.max(0, Number(value.lastUsedAt ?? value.localModifiedAt ?? value.updatedAt ?? 0)),
  };
}

export async function loadLocal(username: string): Promise<LocalVault | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(username);
    req.onsuccess = () => {
      const value = req.result as (Partial<LocalVault> & { updatedAt?: number }) | undefined;
      resolve(value ? normalizeLocal(value, username) : null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function loadRememberedLocal(): Promise<LocalVault | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => {
      const candidates = (req.result as Array<Partial<LocalVault> & { updatedAt?: number }>)
        .map((value) => normalizeLocal(value, String(value.username ?? "")))
        .filter((value) => value.remembered && value.vaultKey && value.salt && value.vault)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
      resolve(candidates[0] ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveLocal(value: LocalVault) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function forgetLocalKey(username: string) {
  const current = await loadLocal(username);
  if (!current) return;
  const { vaultKey: _vaultKey, salt: _salt, remembered: _remembered, ...rest } = current;
  void _vaultKey;
  void _salt;
  void _remembered;
  await saveLocal({ ...rest, remembered: false, lastUsedAt: Date.now() });
}

export async function deleteLocal(username: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(username);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
