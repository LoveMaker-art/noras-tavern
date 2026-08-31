import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StMcpConfig } from "./config.js";

interface Entry { source: string; payload: string; sha256: string | null; bytes: number; }
export interface SnapshotManifest { schema: "nora-resource-snapshot/v2"; id: string; createdAt: string; root: string; files: Entry[]; }
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const within = (root: string, file: string) => file !== root && !path.relative(root, file).startsWith("..") && !path.isAbsolute(path.relative(root, file));
async function canonical(file: string): Promise<string> {
  try { return await fs.realpath(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}

/** File-scoped recovery only. No directory recursion, no inferred instance backups. */
export class SnapshotManager {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: StMcpConfig,
    private readonly limits = { maxSnapshots: 20, maxTotalBytes: 128 * 1024 * 1024, maxSnapshotBytes: 32 * 1024 * 1024 }) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result;
  }
  private async source(file: string): Promise<string> {
    const target = path.resolve(file);
    if (await canonical(target) !== target) throw new Error("Snapshot source must not contain symlinks.");
    const roots = [this.config.projectRoot, this.config.stRoot, this.config.userDataRoot].filter(Boolean) as string[];
    const allowed = target === path.resolve(this.config.configPath) || roots.some(root => within(path.resolve(root), target));
    if (!allowed || target === path.resolve(this.config.snapshotRoot) || within(path.resolve(this.config.snapshotRoot), target)) throw new Error("Snapshot path is outside allowed resources.");
    const stat = await fs.lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (stat && !stat.isFile()) throw new Error("Snapshots accept explicit regular files, not whole directories.");
    return target;
  }
  async create(label = "resource", targets: string[] = []): Promise<SnapshotManifest> {
    return this.serial(async () => {
      if (!targets.length || targets.length > 100) throw new Error("Explicit affected files are required (1–100); whole-instance snapshots are disabled.");
      const entries: Array<{ source: string; data: Buffer | null }> = [];
      let bytes = 0;
      for (const file of [...new Set(targets)]) {
        const source = await this.source(file);
        const stat = await fs.stat(source).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
        bytes += stat?.size || 0;
        if (bytes > this.limits.maxSnapshotBytes || bytes > this.limits.maxTotalBytes) throw new Error("Resource snapshot exceeds byte budget.");
        entries.push({ source, data: stat ? await fs.readFile(source) : null });
      }
      await fs.mkdir(this.config.snapshotRoot, { recursive: true, mode: 0o700 });
      if (await canonical(this.config.snapshotRoot) !== path.resolve(this.config.snapshotRoot)) throw new Error("Snapshot root must not be a symlink.");
      const id = randomUUID() + "-" + (label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50) || "resource");
      const root = path.join(this.config.snapshotRoot, id);
      await fs.mkdir(root, { mode: 0o700 });
      const manifest: SnapshotManifest = { schema: "nora-resource-snapshot/v2", id, root, createdAt: new Date().toISOString(), files: [] };
      try {
        for (const [index, entry] of entries.entries()) {
          const payload = index + ".bin";
          if (entry.data) await fs.writeFile(path.join(root, payload), entry.data, { mode: 0o600 });
          manifest.files.push({ source: entry.source, payload, sha256: entry.data ? hash(entry.data) : null, bytes: entry.data?.length || 0 });
        }
        await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
        await this.prune(id);
        return manifest;
      } catch (error) { await this.removeOwned(root); throw error; }
    });
  }
  private async read(id: string): Promise<SnapshotManifest> {
    if (!/^[a-f0-9-]{36}-[a-zA-Z0-9_-]{1,50}$/.test(id)) throw new Error("Invalid snapshot ID.");
    const root = path.resolve(this.config.snapshotRoot, id);
    if (await canonical(root) !== root) throw new Error("Snapshot symlink denied.");
    const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as SnapshotManifest;
    if (manifest.schema !== "nora-resource-snapshot/v2" || manifest.id !== id || manifest.root !== root || !Array.isArray(manifest.files)) throw new Error("Unsupported snapshot manifest.");
    return manifest;
  }
  async list(): Promise<Array<Pick<SnapshotManifest, "id" | "createdAt" | "root">>> {
    const names = await fs.readdir(this.config.snapshotRoot).catch(error => { if (error.code !== "ENOENT") throw error; return []; });
    const result = [];
    for (const id of names) { try { const m = await this.read(id); result.push({ id, createdAt: m.createdAt, root: m.root }); } catch { /* Never touch legacy/unknown backups. */ } }
    return result;
  }
  async rollback(id: string, expected?: Record<string, string | null>): Promise<{ ok: true; id: string; restored: string[] }> {
    return this.serial(async () => {
      if (!expected) throw new Error("Recovery requires explicit current hashes; stop writers before maintenance.");
      const manifest = await this.read(id);
      const validated: Array<{ source: string; data: Buffer | null }> = [];
      for (const file of manifest.files) {
        const source = await this.source(file.source);
        if (!Object.prototype.hasOwnProperty.call(expected, source)) throw new Error("Missing current hash precondition.");
        const current = await fs.readFile(source).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
        if ((current ? hash(current) : null) !== expected[source]) throw new Error("Resource changed; recovery rejected.");
        if (!/^\d+\.bin$/.test(file.payload)) throw new Error("Invalid snapshot payload.");
        const payload = path.join(manifest.root, file.payload);
        if (await canonical(payload) !== payload) throw new Error("Payload symlink denied.");
        const data = file.sha256 === null ? null : await fs.readFile(payload);
        if (data && hash(data) !== file.sha256) throw new Error("Corrupt snapshot payload.");
        validated.push({ source, data });
      }
      for (const item of validated) {
        if (item.data === null) await fs.unlink(item.source).catch(error => { if (error.code !== "ENOENT") throw error; });
        else {
          await fs.mkdir(path.dirname(item.source), { recursive: true });
          const temp = item.source + "." + randomUUID() + ".restore";
          await fs.writeFile(temp, item.data, { mode: 0o600 }); await fs.rename(temp, item.source);
        }
      }
      return { ok: true, id, restored: validated.map(x => x.source) };
    });
  }
  private async removeOwned(root: string): Promise<void> {
    for (const file of await fs.readdir(root)) {
      if (file !== "manifest.json" && !/^\d+\.bin$/.test(file)) throw new Error("Unknown snapshot file; cleanup stopped.");
      await fs.unlink(path.join(root, file));
    }
    await fs.rmdir(root);
  }
  private async prune(keep: string): Promise<void> {
    const rows = (await this.list()).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    const sizes = new Map<string, number>();
    for (const row of rows) sizes.set(row.id, (await this.read(row.id)).files.reduce((n,x) => n + x.bytes, 0));
    let count = rows.length; let bytes = [...sizes.values()].reduce((n,x) => n+x, 0);
    for (const row of rows) {
      if (count <= this.limits.maxSnapshots && bytes <= this.limits.maxTotalBytes) break;
      if (row.id === keep) continue;
      await this.removeOwned(row.root); count--; bytes -= sizes.get(row.id) || 0;
    }
  }
}
