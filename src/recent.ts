// Recently opened files: stored on disk in Electron's userData on desktop (no 50 MB cap for local files,
// immune to IndexedDB quota/origin issues) and in IndexedDB in the browser edition.

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  pages: number;
  openedAt: number;
  lastPage: number;
  thumb: string;
  data?: Blob;
  filePath?: string;
}

const DB_NAME = "folio";
const STORE = "recent";
const NOTES = "notes";
const AI = "ai";
const MAX_RECENT = 8;
/** Bigger files aren't copied into storage: each cached copy stores the whole PDF, so a few 300 MB files would be gigabytes on disk. */
export const MAX_RECENT_FILE_BYTES = 50 * 1024 * 1024;
let connection: Promise<IDBDatabase> | null = null;

const recentListeners = new Set<() => void>();
export function onRecentChange(listener: () => void) {
  recentListeners.add(listener);
  return () => { recentListeners.delete(listener); };
}
function notifyRecentChanged() {
  for (const listener of recentListeners) {
    try { listener(); } catch {}
  }
}

function open(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(NOTES)) database.createObjectStore(NOTES, { keyPath: "id" });
      if (!database.objectStoreNames.contains(AI)) database.createObjectStore(AI, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const database = req.result;
      database.onversionchange = () => { database.close(); connection = null; };
      database.onclose = () => { connection = null; };
      resolve(database);
    };
    req.onerror = () => { connection = null; reject(req.error); };
  });
  return connection;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const req = fn(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(req.result);
    transaction.onabort = () => reject(transaction.error);
    req.onerror = () => reject(req.error);
  });
}

export const fileId = (name: string, size: number) => `${name}:${size}`;

/** Identifies a PDF by its content: SHA-256 of the first and last megabyte plus its size (fast even for huge files). */
export async function contentKey(data: Uint8Array) {
  const chunk = 1 << 20;
  let sample: Uint8Array = data;
  if (data.byteLength > 2 * chunk) {
    sample = new Uint8Array(2 * chunk);
    sample.set(data.subarray(0, chunk));
    sample.set(data.subarray(data.byteLength - chunk), chunk);
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", sample.slice()));
  return "sha256:" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") + ":" + data.byteLength;
}

async function listRecentIdb(): Promise<RecentFile[]> {
  try {
    const all = await tx<RecentFile[]>("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

async function getRecentIdb(id: string): Promise<RecentFile | undefined> {
  try {
    return await tx<RecentFile | undefined>("readonly", (s) => s.get(id));
  } catch {
    return undefined;
  }
}

export async function listRecent(): Promise<RecentFile[]> {
  const desktop = window.folioDesktop?.recent;
  if (desktop) {
    const [disk, legacy] = await Promise.all([
      desktop.list().catch(() => [] as DesktopRecentEntry[]),
      listRecentIdb(),
    ]);
    const seen = new Set(disk.map((item) => item.id));
    const merged: RecentFile[] = [...disk];
    for (const item of legacy) {
      if (!seen.has(item.id)) merged.push(item);
    }
    return merged.sort((a, b) => b.openedAt - a.openedAt);
  }
  return listRecentIdb();
}

export async function getRecent(id: string): Promise<RecentFile | undefined> {
  const desktop = window.folioDesktop?.recent;
  if (desktop) {
    try {
      const found = await desktop.get(id);
      if (found) return found;
    } catch {}
  }
  return getRecentIdb(id);
}

export async function readRecentBytes(
  fileOrId: RecentFile | string,
): Promise<{ name: string; data: Uint8Array; filePath?: string } | null> {
  const id = typeof fileOrId === "string" ? fileOrId : fileOrId.id;
  const desktop = window.folioDesktop?.recent;
  if (desktop) {
    try {
      const result = await desktop.read(id);
      if (result) return result;
    } catch {}
  }
  const entry = typeof fileOrId === "string" ? await getRecentIdb(id) : (fileOrId.data ? fileOrId : await getRecentIdb(id));
  if (!entry?.data) return null;
  try {
    return { name: entry.name, data: new Uint8Array(await entry.data.arrayBuffer()), filePath: entry.filePath };
  } catch {
    return null;
  }
}

export async function saveRecent(file: RecentFile, keepIds?: ReadonlySet<string>, bytes?: Uint8Array) {
  const desktop = window.folioDesktop?.recent;
  if (desktop) {
    try {
      const entry: DesktopRecentEntry = {
        id: file.id,
        name: file.name,
        size: file.size,
        pages: file.pages,
        openedAt: file.openedAt,
        lastPage: file.lastPage,
        thumb: file.thumb,
        ...(file.filePath ? { filePath: file.filePath } : {}),
      };
      const keep = keepIds ? Array.from(keepIds) : [];
      // When a local filePath is known, let the main process copy it directly without shipping megabytes over IPC.
      let ok = await desktop.save(entry, file.filePath ? null : (bytes ?? null), keep);
      if (!ok && file.filePath && bytes && bytes.byteLength <= MAX_RECENT_FILE_BYTES) {
        ok = await desktop.save(entry, bytes, keep);
      }
      if (ok) {
        notifyRecentChanged();
        return;
      }
    } catch {
      /* fall through to IndexedDB backup */
    }
  }

  try {
    const data = file.data ?? (bytes && bytes.byteLength <= MAX_RECENT_FILE_BYTES
      ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" })
      : undefined);
    if (!data) return;
    await tx("readwrite", (s) => s.put({ ...file, data }));
    const all = await listRecentIdb();
    // Never evict documents that are currently open in a tab so session restore stays intact.
    let closedCount = 0;
    for (const item of all) {
      if (keepIds?.has(item.id)) continue;
      if (++closedCount > MAX_RECENT) await tx("readwrite", (s) => s.delete(item.id)).catch(() => {});
    }
    notifyRecentChanged();
  } catch {
    /* storage may be unavailable (private mode); recent files are best-effort */
  }
}

export async function updateRecentThumb(id: string, thumb: string) {
  if (!thumb) return;
  let updated = false;
  const desktop = window.folioDesktop?.recent;
  if (desktop) {
    try {
      if (await desktop.update(id, { thumb })) updated = true;
    } catch {}
  }
  try {
    const database = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const file = request.result as RecentFile | undefined;
        if (file && file.thumb !== thumb) {
          store.put({ ...file, thumb });
          updated = true;
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {}
  if (updated) notifyRecentChanged();
}

export async function updateLastPage(id: string, lastPage: number) {
  const desktop = window.folioDesktop?.recent;
  if (desktop) {
    try {
      await desktop.update(id, { lastPage });
    } catch {}
  }
  try {
    const database = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const file = request.result as RecentFile | undefined;
        if (file && file.lastPage !== lastPage) store.put({ ...file, lastPage });
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {}
}

export async function clearRecent() {
  try {
    await window.folioDesktop?.recent?.clear();
  } catch {}
  try {
    await tx("readwrite", (s) => s.clear());
  } catch {
    /* ignore */
  }
  notifyRecentChanged();
}

export async function removeRecent(id: string) {
  try {
    await window.folioDesktop?.recent?.remove(id);
  } catch {}
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* ignore */
  }
  notifyRecentChanged();
}

// ── Highlights and notes ──────────────────────────────────────────────
// Saved per document (same id as Recent) so markup survives closing Folio.

export interface StoredMark {
  id: string;
  type: "highlight" | "ink" | "freetext";
  page: number; // 0-based
  text: string;
  note: string;
  color: string;
  createdAt: number;
  /** pdf.js editor serialization, used to recreate the mark. */
  data: Record<string, unknown>;
}

export interface DocNotes {
  id: string;
  note: string;
  marks: StoredMark[];
  updatedAt: number;
}

export async function getNotes(id: string): Promise<DocNotes | undefined> {
  try {
    return await tx<DocNotes | undefined>("readonly", (s) => s.get(id), NOTES);
  } catch {
    return undefined;
  }
}

export async function saveNotes(notes: DocNotes) {
  try {
    if (!notes.note.trim() && notes.marks.length === 0) await tx("readwrite", (s) => s.delete(notes.id), NOTES);
    else await tx("readwrite", (s) => s.put(notes), NOTES);
  } catch {
    /* best-effort, like Recent */
  }
}

// ── Ask AI conversations ──────────────────────────────────────────────
// One conversation per document (same content-based id as notes), so it's there when the document is reopened.

export interface StoredAiMessage {
  role: "user" | "assistant";
  content: string;
  context?: { text: string; page: number };
}

export async function getAiHistory(id: string): Promise<StoredAiMessage[]> {
  try {
    const record = await tx<{ id: string; messages: StoredAiMessage[] } | undefined>("readonly", (s) => s.get(id), AI);
    return Array.isArray(record?.messages) ? record.messages : [];
  } catch {
    return [];
  }
}

export async function saveAiHistory(id: string, messages: StoredAiMessage[]) {
  try {
    if (messages.length === 0) await tx("readwrite", (s) => s.delete(id), AI);
    else await tx("readwrite", (s) => s.put({ id, messages, updatedAt: Date.now() }), AI);
  } catch {
    /* best-effort, like notes */
  }
}
