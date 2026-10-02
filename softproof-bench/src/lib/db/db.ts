/**
 * All persistence stays in the browser via IndexedDB - images and ICC profiles
 * are never uploaded. Two object stores:
 *
 *  projects  - full working state incl. original image bytes, embedded ICC,
 *              chosen source/target profile ids, settings and preview caches.
 *  profiles  - operator's ICC library (plus first-run seeded open profiles).
 */
import type { RenderingIntent } from '../color/lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';

const DB_NAME = 'softproof-bench';
const DB_VERSION = 1;
export const STORE_PROJECTS = 'projects';
export const STORE_PROFILES = 'profiles';

export interface StoredProfile {
  id: string;
  bytes: Uint8Array;
  description: string;
  colorSpace: ColorSpaceKind;
  channels: number;
  origin: 'builtin-open' | 'user-imported' | 'handoff-imported';
  addedAt: string;
  size: number;
  /** SHA-256 hex fingerprint of bytes; backfilled for legacy records on first handoff import. */
  sha256?: string;
  /** Original file name when known (kept as evidence). */
  fileName?: string;
  /** Provenance when this profile arrived via a handoff package. */
  handoff?: {
    /** SHA-256 of the package manifest this profile arrived in. */
    packageHash: string;
    importedAt: string;
    /** File name the package recorded for this profile. */
    bundleFileName: string;
  };
}

export interface StoredProject {
  id: string;
  name: string;
  updatedAt: string;
  imageBytes: Uint8Array;
  imageName: string;
  embeddedICC?: Uint8Array;
  /** id into profiles store, or null until the operator chooses one. */
  sourceProfileId: string | null;
  sourceIsEmbedded: boolean;
  sourceAssumptionNote?: string;
  targetProfileId: string | null;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  /** Soft-proof simulation intent (schema 2+; absent in legacy records). */
  proofIntent?: RenderingIntent;
  /** Record shape version: 2 = handoff-era. Absent means legacy (pre-handoff). */
  schemaVersion?: number;
  provenanceSeen?: boolean; // image already carried a conversion marker
  /** Present when this project was imported from a handoff package. */
  handoff?: {
    /** SHA-256 of the package manifest — the package identity. */
    packageHash: string;
    /** SHA-256 of the canonical project content — the idempotency key. */
    contentHash: string;
    importedAt: string;
    format: string;
  };
  previewCache?: {
    paramsKey: string;
    rgba: Uint8Array;
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        db.createObjectStore(STORE_PROFILES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut<T>(store: string, value: T): Promise<unknown> {
  return tx(store, 'readwrite', (s) => s.put(value));
}
export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}
export async function idbDelete(store: string, key: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(key));
}
export async function idbAll<T>(store: string): Promise<T[]> {
  return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}
export async function idbKeys(store: string): Promise<string[]> {
  return tx(store, 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>).then((k) => k.map(String));
}

/**
 * Commit several puts across BOTH stores in a single IndexedDB transaction.
 * This is the only write path for handoff imports: either every planned write
 * lands or none does, so a failed import can never leave half a project or
 * orphaned profiles behind.
 */
export async function idbAtomicPut(entries: { store: string; value: object }[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_PROJECTS, STORE_PROFILES], 'readwrite');
    for (const e of entries) t.objectStore(e.store).put(e.value);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB 事务失败'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB 事务被中止，未写入任何内容'));
  });
}
