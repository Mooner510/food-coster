import type { EncryptedVault } from "./crypto";

export type LocalVault = {
  username: string;
  verifierHash: string;
  vault: EncryptedVault;
  serverRevision: number;
  localModifiedAt: number;
  pendingSync: boolean;
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

export async function loadLocal(username: string): Promise<LocalVault | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(username);
    req.onsuccess = () => {
      const value = req.result as Partial<LocalVault> & { updatedAt?: number } | undefined;
      if (!value) return resolve(null);
      resolve({
        username: String(value.username ?? username),
        verifierHash: String(value.verifierHash ?? ""),
        vault: value.vault as EncryptedVault,
        serverRevision: Math.max(0, Number(value.serverRevision ?? 0)),
        localModifiedAt: Math.max(0, Number(value.localModifiedAt ?? value.updatedAt ?? 0)),
        pendingSync: Boolean(value.pendingSync),
      });
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

export async function deleteLocal(username: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(username);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
