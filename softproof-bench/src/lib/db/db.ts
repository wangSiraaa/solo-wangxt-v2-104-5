/**
 * All persistence stays in the browser via IndexedDB - images and ICC profiles
 * are never uploaded. Two object stores:
 *
 *  projects  - full working state incl. original image bytes, embedded ICC,
 *              chosen source/target profile ids, settings and preview caches.
 *  profiles  - operator's ICC library (plus first-run seeded open profiles).
 *
 * Record versioning (no object-store schema changes, so old browsers and new
 * handover packages coexist in the same DB_VERSION):
 *
 *  StoredProfile.sha256 / packageSource  - absent on legacy rows, backfilled
 *                                           lazily on startup (visible migration).
 *  StoredProject.recordVersion           - undefined = legacy v0 project;
 *                                           1 = fingerprint-bearing record,
 *                                           optionally with `handover` metadata.
 */
import type { RenderingIntent } from '../color/lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';

const DB_NAME = 'softproof-bench';
const DB_VERSION = 1;
export const STORE_PROJECTS = 'projects';
export const STORE_PROFILES = 'profiles';

export const CURRENT_RECORD_VERSION = 1;

/** Provenance carried with an ICC profile that arrived inside a handover package. */
export interface ProfilePackageSource {
  packageFormat: 'softproof-bench-handover';
  formatVersion: number;
  /** Project the profile belonged to on the exporting machine. */
  projectName: string;
  exportedAt: string;
  /** Why this profile was inside the package. */
  role: 'source-assumed' | 'target' | 'embedded-evidence';
}

export interface StoredProfile {
  id: string;
  bytes: Uint8Array;
  description: string;
  colorSpace: ColorSpaceKind;
  channels: number;
  origin: 'builtin-open' | 'user-imported';
  addedAt: string;
  size: number;
  /** Content fingerprint (sha256 hex). Backfilled for legacy rows. */
  sha256?: string;
  /** Present only when the profile came from a handover package. */
  packageSource?: ProfilePackageSource;
}

export interface HandoverMeta {
  packageFormat: 'softproof-bench-handover';
  packageFormatVersion: number;
  importedAt: string;
  exportedAt: string;
  sourceKind: 'embedded' | 'assumed';
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
  /** Absent on legacy v0 rows (loaders then fall back to relative-colorimetric). */
  proofIntent?: RenderingIntent;
  provenanceSeen?: boolean; // image already carried a conversion marker
  previewCache?: {
    paramsKey: string;
    rgba: Uint8Array;
  };
  // --- record version 1 (fingerprint-bearing; absent on legacy v0 rows) ---
  recordVersion?: number;
  imageSha256?: string;
  sourceSha256?: string | null;
  targetSha256?: string | null;
  /** Present only when the project was restored from a handover package. */
  handover?: HandoverMeta;
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
 * Apply several puts/deletes across stores inside ONE transaction. IndexedDB
 * guarantees atomicity: if any request fails (or fn throws), the whole
 * transaction aborts and none of the stores are modified - this is what keeps a
 * rejected/failing handover import from leaving a half project or an orphan
 * profile behind.
 */
export async function idbAtomic(
  stores: string[],
  fn: (stores: IDBObjectStore[]) => void,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction error'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
    try {
      fn(stores.map((name) => t.objectStore(name)));
    } catch (err) {
      t.abort();
      reject(err);
    }
  });
}
