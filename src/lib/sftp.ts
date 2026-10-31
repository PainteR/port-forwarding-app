export type FileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: number | null;
  permissions: number | null;
};

export type FileListing = { path: string; entries: FileEntry[] };
export type TransferMode = "sftp" | "archive";
export type TransferDirection = "upload" | "download";
export type TransferEvent = {
  type: "progress" | "completed" | "cancelled" | "error";
  transferId: string;
  bytesTransferred: number;
  totalBytes: number | null;
  filesTransferred: number;
  currentPath: string;
  message: string | null;
};

export function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "") || "/";
  const index = clean.lastIndexOf("/");
  return index <= 0 ? "/" : clean.slice(0, index);
}

export function joinPath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export function validFileName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[\/\\\0]/.test(name);
}

export function parsePermissions(value: string): number | null {
  return /^0?[0-7]{3}$/.test(value) ? Number.parseInt(value, 8) : null;
}

export function formatPermissions(value: number | null): string {
  return value === null ? "—" : (value & 0o7777).toString(8).padStart(3, "0");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent - 1]}`;
}

export function transferPercent(bytes: number, total: number | null): number | null {
  return total === null || total <= 0 ? null : Math.min(100, Math.max(0, (bytes / total) * 100));
}

export function visibleEntries(entries: FileEntry[], query: string, showHidden: boolean): FileEntry[] {
  const search = query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => (showHidden || !entry.name.startsWith(".")) && entry.name.toLocaleLowerCase().includes(search))
    .sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, undefined, { numeric: true }));
}
