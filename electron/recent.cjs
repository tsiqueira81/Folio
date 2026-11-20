// Disk-backed Recent files store for the desktop app (stored in Electron's userData folder).
// Storing recent metadata and cached copies on disk avoids IndexedDB quota/origin quirks on custom
// protocols and lets local PDFs of any size reopen directly from their original path.
const { app } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_RECENT = 8;
const MAX_CACHED_BYTES = 50 * 1024 * 1024;
const MAX_READ_BYTES = 300 * 1024 * 1024;
const MAX_THUMB_CHARS = 500_000;

function indexPath() {
  return path.join(app.getPath("userData"), "recent.json");
}

function cacheDir() {
  return path.join(app.getPath("userData"), "recent-files");
}

function cacheNameFor(id) {
  return `${crypto.createHash("sha256").update(String(id)).digest("hex")}.pdf`;
}

function validPdfPath(filePath) {
  if (typeof filePath !== "string" || !filePath || !path.isAbsolute(filePath)) return false;
  if (!/\.pdf$/i.test(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_READ_BYTES;
  } catch {
    return false;
  }
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
      .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  } catch {
    return [];
  }
}

function writeIndex(entries) {
  const dest = indexPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, dest);
}

function removeCachedFile(cachedName) {
  if (!cachedName || !/^[a-f0-9]{64}\.pdf$/i.test(cachedName)) return;
  try {
    fs.unlinkSync(path.join(cacheDir(), cachedName));
  } catch {}
}

function toPublicEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    size: entry.size,
    pages: entry.pages,
    openedAt: entry.openedAt,
    lastPage: entry.lastPage,
    thumb: entry.thumb || "",
    ...(entry.filePath ? { filePath: entry.filePath } : {}),
  };
}

// Serialize mutations so concurrent tab opens/updates never overwrite each other.
let writeChain = Promise.resolve();
function enqueue(task) {
  const next = writeChain.then(task, task);
  writeChain = next.then(() => {}, () => {});
  return next;
}

function register(handle) {
  handle("folio:recent-list", () => readIndex().map(toPublicEntry));

  handle("folio:recent-get", (_event, id) => {
    if (typeof id !== "string" || !id) return null;
    const found = readIndex().find((item) => item.id === id);
    return found ? toPublicEntry(found) : null;
  });

  handle("folio:recent-read", async (_event, id) => {
    if (typeof id !== "string" || !id) return null;
    const found = readIndex().find((item) => item.id === id);
    if (!found) return null;

    if (found.filePath && validPdfPath(found.filePath)) {
      try {
        const data = await fs.promises.readFile(found.filePath);
        return { name: found.name, data, filePath: found.filePath };
      } catch {}
    }

    if (found.cachedName && /^[a-f0-9]{64}\.pdf$/i.test(found.cachedName)) {
      const cached = path.join(cacheDir(), found.cachedName);
      try {
        const stat = await fs.promises.stat(cached);
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_READ_BYTES) {
          const data = await fs.promises.readFile(cached);
          return { name: found.name, data, filePath: found.filePath || undefined };
        }
      } catch {}
    }

    return null;
  });

  handle("folio:recent-save", (_event, entry, bytes, keepIds) => enqueue(async () => {
    if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.name !== "string" || !entry.name) return false;
    const size = Number(entry.size);
    const pages = Number(entry.pages);
    if (!Number.isFinite(size) || size < 0 || !Number.isInteger(pages) || pages < 1) return false;

    const entries = readIndex();
    const existing = entries.find((item) => item.id === entry.id);

    const filePath = validPdfPath(entry.filePath)
      ? entry.filePath
      : (existing?.filePath && validPdfPath(existing.filePath) ? existing.filePath : undefined);

    let cachedName = existing?.cachedName;
    const targetCacheName = cacheNameFor(entry.id);
    const targetCachePath = path.join(cacheDir(), targetCacheName);

    if (bytes && bytes.byteLength > 0 && bytes.byteLength <= MAX_CACHED_BYTES) {
      await fs.promises.mkdir(cacheDir(), { recursive: true });
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const tmp = `${targetCachePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, targetCachePath);
      cachedName = targetCacheName;
    } else if (filePath && size <= MAX_CACHED_BYTES) {
      // Keep a lightweight cached copy for local files <= 50 MB so temp/email PDFs remain reopenable even if moved.
      try {
        await fs.promises.mkdir(cacheDir(), { recursive: true });
        await fs.promises.copyFile(filePath, targetCachePath);
        cachedName = targetCacheName;
      } catch {}
    }

    // Must have either a valid local file path or a cached copy to be reopenable.
    if (!filePath && !cachedName) return false;

    const thumb = typeof entry.thumb === "string" && entry.thumb.startsWith("data:image/") && entry.thumb.length <= MAX_THUMB_CHARS
      ? entry.thumb
      : (existing?.thumb || "");
    const openedAt = Number.isFinite(Number(entry.openedAt)) ? Number(entry.openedAt) : Date.now();
    const lastPage = Number.isInteger(entry.lastPage) && entry.lastPage >= 1
      ? Math.min(entry.lastPage, pages)
      : (existing?.lastPage ? Math.min(existing.lastPage, pages) : 1);

    const nextEntry = {
      id: entry.id,
      name: entry.name,
      size,
      pages,
      openedAt,
      lastPage,
      thumb,
      ...(filePath ? { filePath } : {}),
      ...(cachedName ? { cachedName } : {}),
    };

    const merged = [nextEntry, ...entries.filter((item) => item.id !== entry.id)]
      .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));

    const keepSet = new Set(Array.isArray(keepIds) ? keepIds.filter((x) => typeof x === "string") : []);
    const kept = [];
    let closedCount = 0;
    for (const item of merged) {
      if (keepSet.has(item.id)) {
        kept.push(item);
      } else if (++closedCount <= MAX_RECENT) {
        kept.push(item);
      } else {
        removeCachedFile(item.cachedName);
      }
    }

    writeIndex(kept);
    return true;
  }));

  handle("folio:recent-update", (_event, id, patch) => enqueue(() => {
    if (typeof id !== "string" || !id || !patch || typeof patch !== "object") return false;
    const entries = readIndex();
    const idx = entries.findIndex((item) => item.id === id);
    if (idx === -1) return false;

    const current = entries[idx];
    let changed = false;
    const updated = { ...current };

    if (Number.isInteger(patch.lastPage) && patch.lastPage >= 1) {
      const clamped = Math.min(patch.lastPage, current.pages || patch.lastPage);
      if (clamped !== current.lastPage) {
        updated.lastPage = clamped;
        changed = true;
      }
    }

    if (typeof patch.thumb === "string" && patch.thumb.startsWith("data:image/") && patch.thumb.length <= MAX_THUMB_CHARS) {
      if (patch.thumb !== current.thumb) {
        updated.thumb = patch.thumb;
        changed = true;
      }
    }

    if (changed) {
      entries[idx] = updated;
      writeIndex(entries);
    }
    return changed;
  }));

  handle("folio:recent-remove", (_event, id) => enqueue(() => {
    if (typeof id !== "string" || !id) return false;
    const entries = readIndex();
    const target = entries.find((item) => item.id === id);
    if (!target) return false;
    removeCachedFile(target.cachedName);
    writeIndex(entries.filter((item) => item.id !== id));
    return true;
  }));

  handle("folio:recent-clear", () => enqueue(() => {
    const entries = readIndex();
    for (const item of entries) removeCachedFile(item.cachedName);
    try {
      fs.rmSync(cacheDir(), { recursive: true, force: true });
    } catch {}
    writeIndex([]);
    return true;
  }));
}

module.exports = { register };
