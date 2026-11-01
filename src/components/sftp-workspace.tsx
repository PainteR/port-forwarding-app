import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import {
  ArrowDownIcon, ArrowUpIcon, CheckCircle2Icon, ChevronUpIcon, EllipsisIcon,
  FileIcon, FilePenLineIcon, FolderIcon, FolderPlusIcon, HardDriveIcon,
  HomeIcon, KeyRoundIcon, LinkIcon, LoaderCircleIcon, PencilIcon,
  RefreshCwIcon, SearchIcon, ServerIcon, Trash2Icon, XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  formatBytes, formatPermissions, joinPath, parentPath, parsePermissions,
  transferPercent, validFileName, visibleEntries,
  type FileEntry, type FileListing, type TransferDirection, type TransferEvent, type TransferMode,
} from "@/lib/sftp";
import "./sftp-workspace.css";

type Side = "local" | "remote";
type FileDrag = { token: string; serverId: string; side: Side; directory: string; paths: string[] };
type DropTarget = { side: Side; path: string };
const FILE_DRAG_TYPE = "application/x-port-forward-files";
type Pane = {
  path: string;
  input: string;
  entries: FileEntry[];
  selected: string[];
  query: string;
  loading: boolean;
  loaded: boolean;
  error: string | null;
};
type Transfer = {
  id: string;
  direction: TransferDirection;
  sources: string[];
  destination: string;
  mode: TransferMode;
  overwrite: boolean;
  state: "queued" | "running" | "completed" | "cancelled" | "error";
  bytes: number;
  total: number | null;
  files: number;
  path: string;
  started: number;
  updated: number;
  message: string | null;
};
type FileAction = {
  kind: "mkdir" | "rename" | "delete" | "chmod" | "edit";
  side: Side;
  paths: string[];
  value: string;
  content: string;
  revision: string;
  loading: boolean;
  error: string | null;
};
const newPane = (): Pane => ({ path: "", input: "", entries: [], selected: [], query: "", loading: false, loaded: false, error: null });
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function SftpWorkspace({ serverId, serverName, active }: { serverId: string; serverName: string; active: boolean }) {
  const [panes, setPanes] = useState<Record<Side, Pane>>({ local: newPane(), remote: newPane() });
  const [showHidden, setShowHidden] = useState(false);
  const [mode, setMode] = useState<TransferMode>("sftp");
  const [overwrite, setOverwrite] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [action, setAction] = useState<FileAction | null>(null);
  const [dragSession, setDragSession] = useState<FileDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const fileDrag = useRef<FileDrag | null>(null);
  const alive = useRef(true);
  const requests = useRef({ local: 0, remote: 0 });
  const running = useRef<string | null>(null);
  const transferIds = useRef(new Set<string>());
  const cancelling = useRef(new Set<string>());
  const transferList = useRef<HTMLDivElement>(null);
  const transferRows = useRef(new Map<string, HTMLDivElement>());
  const previousTransferStates = useRef(new Map<string, Transfer["state"]>());
  const pendingTransferScroll = useRef<string | null>(null);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const desktop = isTauri();

  const endpoint = (side: Side) => side === "local" ? null : serverId;
  const updatePane = (side: Side, patch: Partial<Pane>) => {
    if (alive.current) setPanes((current) => ({ ...current, [side]: { ...current[side], ...patch } }));
  };

  async function list(side: Side, path: string | null = panesRef.current[side].path || null) {
    if (!desktop) return;
    const request = ++requests.current[side];
    updatePane(side, { loading: true, error: null });
    try {
      const result = await invoke<FileListing>("sftp_list", { serverId: endpoint(side), path });
      if (!alive.current || requests.current[side] !== request) return;
      updatePane(side, { path: result.path, input: result.path, entries: result.entries, selected: [], loading: false, loaded: true });
    } catch (error) {
      if (requests.current[side] === request) updatePane(side, { loading: false, error: messageOf(error) });
    }
  }

  useEffect(() => {
    alive.current = true;
    if (desktop) {
      void list("local", null);
      void list("remote", null);
    }
    return () => {
      alive.current = false;
      requests.current.local++;
      requests.current.remote++;
      for (const transferId of transferIds.current) {
        cancelling.current.add(transferId);
        void invoke("sftp_cancel", { transferId }).catch(() => {});
      }
    };
  }, [serverId]);

  useEffect(() => {
    if (!active) clearDrag();
  }, [active]);

  useEffect(() => {
    if (!desktop || running.current || !alive.current) return;
    const next = transfers.find((transfer) => transfer.state === "queued");
    if (!next) return;
    running.current = next.id;
    transferIds.current.add(next.id);
    setTransfers((current) => current.map((item) => item.id === next.id ? { ...item, state: "running", started: Date.now(), updated: Date.now() } : item));
    const onEvent = new Channel<TransferEvent>();
    onEvent.onmessage = (event) => {
      if (!alive.current || event.transferId !== next.id) return;
      setTransfers((current) => current.map((item) => item.id === next.id ? {
        ...item, bytes: event.bytesTransferred, total: event.totalBytes, files: event.filesTransferred,
        path: event.currentPath, updated: Date.now(), message: event.message,
        state: event.type === "progress" ? "running" : event.type,
      } : item));
    };
    void invoke("sftp_transfer", {
      serverId, transferId: next.id, direction: next.direction, sources: next.sources,
      destination: next.destination, mode: next.mode, overwrite: next.overwrite, onEvent,
    }).then(() => {
      if (alive.current) setTransfers((current) => current.map((item) => item.id === next.id && item.state === "running" ? { ...item, state: cancelling.current.has(next.id) ? "cancelled" : "completed" } : item));
    }).catch((error) => {
      if (alive.current) setTransfers((current) => current.map((item) => item.id === next.id && item.state === "running" ? {
        ...item, state: cancelling.current.has(next.id) ? "cancelled" : "error", message: messageOf(error),
      } : item));
    }).finally(() => {
      // A cancellation can race backend registration; close it again after completion.
      if (!alive.current) void invoke("sftp_cancel", { transferId: next.id }).catch(() => {});
      transferIds.current.delete(next.id);
      cancelling.current.delete(next.id);
      running.current = null;
      if (alive.current) {
        void list("local");
        void list("remote");
        setTransfers((current) => [...current]);
      }
    });
  }, [transfers, serverId, desktop]);

  useLayoutEffect(() => {
    // Follow queue activity and finished transfers, without pulling the history
    // away from the user on every progress update. Keep the target while hidden.
    for (const transfer of transfers) {
      if (previousTransferStates.current.get(transfer.id) !== transfer.state) {
        pendingTransferScroll.current = transfer.id;
      }
    }
    previousTransferStates.current = new Map(transfers.map((transfer) => [transfer.id, transfer.state]));
    const list = transferList.current;
    const row = pendingTransferScroll.current ? transferRows.current.get(pendingTransferScroll.current) : null;
    if (!active || !list || !row || !list.clientHeight) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTo({
        top: Math.max(0, bottom - list.clientHeight),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
    pendingTransferScroll.current = null;
  }, [transfers, active]);

  function enqueue(direction: TransferDirection, paths?: string[], destinationPath?: string) {
    const source = panesRef.current[direction === "upload" ? "local" : "remote"];
    const destination = panesRef.current[direction === "upload" ? "remote" : "local"];
    const sources = paths ?? source.selected;
    const target = destinationPath ?? destination.path;
    if (!desktop || !sources.length || source.loading || destination.loading || !source.loaded || !destination.loaded) return;
    if (!sources.every((path) => source.entries.some((entry) => entry.path === path && (entry.kind === "file" || entry.kind === "directory")))) return;
    if (target !== destination.path && !destination.entries.some((entry) => entry.path === target && entry.kind === "directory")) return;
    setTransfers((current) => [...current, {
      id: crypto.randomUUID(), direction, sources: [...sources], destination: target, mode, overwrite,
      state: "queued", bytes: 0, total: null, files: 0, path: "", started: 0, updated: 0, message: null,
    }]);
  }

  function clearDrag() {
    fileDrag.current = null;
    setDragSession(null);
    setDropTarget(null);
  }

  function beginDrag(event: DragEvent<HTMLElement>, side: Side, entry: FileEntry) {
    const pane = panesRef.current[side];
    const paths = pane.selected.includes(entry.path) ? [...pane.selected] : [entry.path];
    if (!desktop || !active || pane.loading || !pane.loaded || !paths.every((path) => pane.entries.some((item) => item.path === path && (item.kind === "file" || item.kind === "directory")))) {
      event.preventDefault();
      return;
    }
    const session: FileDrag = { token: crypto.randomUUID(), serverId, side, directory: pane.path, paths };
    // Only this in-memory session supplies source paths. Drop payloads from
    // another window/application are never interpreted as local or remote paths.
    event.dataTransfer.setData(FILE_DRAG_TYPE, session.token);
    event.dataTransfer.effectAllowed = "copy";
    fileDrag.current = session;
    setDragSession(session);
    updatePane(side, { selected: paths });
  }

  function canDrop(event: DragEvent<HTMLElement>, side: Side, path: string) {
    const session = fileDrag.current;
    if (!desktop || !active || !session || session.serverId !== serverId || session.side === side || !event.dataTransfer.types.includes(FILE_DRAG_TYPE)) return false;
    const source = panesRef.current[session.side];
    const destination = panesRef.current[side];
    return source.loaded && !source.loading && destination.loaded && !destination.loading
      && source.path === session.directory
      && session.paths.every((sourcePath) => source.entries.some((entry) => entry.path === sourcePath && (entry.kind === "file" || entry.kind === "directory")))
      && (path === destination.path || destination.entries.some((entry) => entry.path === path && entry.kind === "directory"));
  }

  function dragOver(event: DragEvent<HTMLElement>, side: Side, path: string) {
    event.preventDefault();
    event.stopPropagation();
    const valid = canDrop(event, side, path);
    event.dataTransfer.dropEffect = valid ? "copy" : "none";
    setDropTarget((current) => valid ? current?.side === side && current.path === path ? current : { side, path } : null);
  }

  function dropFiles(event: DragEvent<HTMLElement>, side: Side, path: string) {
    event.preventDefault();
    event.stopPropagation();
    const session = fileDrag.current;
    if (canDrop(event, side, path) && session && event.dataTransfer.getData(FILE_DRAG_TYPE) === session.token) {
      enqueue(session.side === "local" ? "upload" : "download", session.paths, path);
    }
    clearDrag();
  }

  function leavePane(event: DragEvent<HTMLElement>, side: Side) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom) return;
    setDropTarget((current) => current?.side === side ? null : current);
  }

  async function cancelTransfer(transfer: Transfer) {
    if (transfer.state === "queued") {
      setTransfers((current) => current.map((item) => item.id === transfer.id ? { ...item, state: "cancelled" } : item));
      return;
    }
    cancelling.current.add(transfer.id);
    try { await invoke("sftp_cancel", { transferId: transfer.id }); }
    catch (error) {
      if (alive.current) setTransfers((current) => current.map((item) => item.id === transfer.id ? { ...item, message: messageOf(error) } : item));
    }
  }

  async function openAction(kind: FileAction["kind"], side: Side, entry?: FileEntry) {
    const paths = entry ? [entry.path] : panes[side].selected;
    const next: FileAction = {
      kind, side, paths,
      value: kind === "chmod" ? formatPermissions(entry?.permissions ?? null) : kind === "rename" ? entry?.name ?? "" : "",
      content: "", revision: "", loading: kind === "edit", error: null,
    };
    setAction(next);
    if (kind === "edit" && paths[0]) {
      try {
        const result = await invoke<{ content: string; revision: string }>("sftp_read_text", { serverId: endpoint(side), path: paths[0] });
        if (alive.current) setAction((current) => current === next ? { ...next, ...result, loading: false } : current);
      } catch (error) {
        if (alive.current) setAction((current) => current === next ? { ...next, loading: false, error: messageOf(error) } : current);
      }
    }
  }

  async function submitAction(event: FormEvent) {
    event.preventDefault();
    if (!action || action.loading) return;
    const current = action;
    if ((current.kind === "mkdir" || current.kind === "rename") && !validFileName(current.value)) {
      setAction({ ...current, error: "Enter a single name without slashes. The names . and .. are reserved." });
      return;
    }
    if (current.kind === "chmod" && parsePermissions(current.value) === null) {
      setAction({ ...current, error: "Use an octal mode from 000 to 777, for example 644 or 0755." });
      return;
    }
    setAction({ ...current, loading: true, error: null });
    const common = { serverId: endpoint(current.side) };
    try {
      if (current.kind === "mkdir") await invoke("sftp_mkdir", { ...common, path: joinPath(panes[current.side].path, current.value) });
      if (current.kind === "rename") await invoke("sftp_rename", { ...common, path: current.paths[0], newPath: joinPath(parentPath(current.paths[0]), current.value) });
      if (current.kind === "delete") await invoke("sftp_delete", { ...common, paths: current.paths });
      if (current.kind === "chmod") await invoke("sftp_chmod", { ...common, path: current.paths[0], permissions: parsePermissions(current.value) });
      if (current.kind === "edit") await invoke("sftp_write_text", { ...common, path: current.paths[0], content: current.content, revision: current.revision });
      if (alive.current) { setAction(null); void list(current.side); }
    } catch (error) {
      if (alive.current) setAction({ ...current, loading: false, error: messageOf(error) });
    }
  }

  function toggle(side: Side, path: string) {
    const selected = panes[side].selected;
    updatePane(side, { selected: selected.includes(path) ? selected.filter((item) => item !== path) : [...selected, path] });
  }

  function renderPane(side: Side) {
    const pane = panes[side];
    const entries = visibleEntries(pane.entries, pane.query, showHidden);
    const transferEnabled = pane.selected.length > 0 && pane.selected.every((path) => pane.entries.some((entry) => entry.path === path && (entry.kind === "file" || entry.kind === "directory")));
    const isDropTarget = dropTarget?.side === side;
    return <section className="sftp-pane" aria-label={side === "local" ? "Local files" : "Remote files"} data-drop-target={isDropTarget} onDragOver={(event) => dragOver(event, side, pane.path)} onDragLeave={(event) => leavePane(event, side)} onDrop={(event) => dropFiles(event, side, pane.path)}>
      <header className="sftp-pane-heading">
        {side === "local" ? <HardDriveIcon /> : <ServerIcon />}
        <div><h3>{side === "local" ? "This computer" : serverName}</h3><p>{side === "local" ? "Local files" : "Remote files · SFTP"}</p></div>
        <Button size="icon-sm" variant="ghost" title={`Refresh ${side} files`} aria-label={`Refresh ${side} files`} disabled={pane.loading || !desktop} onClick={() => void list(side)}><RefreshCwIcon className={pane.loading ? "animate-spin" : undefined} /></Button>
      </header>
      <form className="sftp-path" onSubmit={(event) => { event.preventDefault(); void list(side, pane.input); }}>
        <Button size="icon-sm" variant="ghost" type="button" title="Parent folder" aria-label={`${side} parent folder`} disabled={!pane.path || pane.loading} onClick={() => void list(side, parentPath(pane.path))}><ChevronUpIcon /></Button>
        <Button size="icon-sm" variant="ghost" type="button" title="Home folder" aria-label={`${side} home folder`} disabled={!desktop || pane.loading} onClick={() => void list(side, null)}><HomeIcon /></Button>
        <Input value={pane.input} aria-label={`${side} directory path`} placeholder="Directory path" disabled={!desktop} onChange={(event) => updatePane(side, { input: event.target.value })} />
        <Button size="sm" variant="outline" disabled={!desktop || pane.loading || !pane.input.trim()}>Go</Button>
      </form>
      <div className="sftp-pane-tools">
        <div className="sftp-search"><SearchIcon /><Input type="search" aria-label={`Search ${side} files`} placeholder="Filter files…" value={pane.query} onChange={(event) => updatePane(side, { query: event.target.value, selected: [] })} /></div>
        <Button variant="ghost" size="icon-sm" title="New folder" aria-label={`New ${side} folder`} disabled={!pane.loaded || pane.loading} onClick={() => void openAction("mkdir", side)}><FolderPlusIcon /></Button>
        <Button variant="ghost" size="icon-sm" title="Delete selection" aria-label={`Delete selected ${side} files`} disabled={!pane.selected.length || pane.loading} onClick={() => void openAction("delete", side)}><Trash2Icon /></Button>
      </div>
      {pane.error && <div className="sftp-error" role="alert"><p>{pane.error}</p><Button size="sm" variant="outline" onClick={() => void list(side)}>Retry</Button></div>}
      <div className="sftp-file-list" aria-busy={pane.loading}>
        <table>
          <thead><tr><th className="sftp-check"><Checkbox aria-label={`Select all ${side} files`} checked={entries.length > 0 && entries.every((entry) => pane.selected.includes(entry.path)) ? true : entries.some((entry) => pane.selected.includes(entry.path)) ? "indeterminate" : false} onCheckedChange={(checked) => updatePane(side, { selected: checked === true ? entries.map((entry) => entry.path) : [] })} /></th><th>Name</th><th>Size</th><th>Modified</th><th>Mode</th><th /></tr></thead>
          <tbody>{entries.map((entry) => <tr key={entry.path} data-selected={pane.selected.includes(entry.path)} data-dragging={dragSession?.side === side && dragSession.paths.includes(entry.path)} data-drop-target={isDropTarget && dropTarget.path === entry.path} draggable={desktop && !pane.loading && (entry.kind === "file" || entry.kind === "directory") && (!pane.selected.includes(entry.path) || transferEnabled)} onDragStart={(event) => beginDrag(event, side, entry)} onDragEnd={clearDrag} onDragOver={entry.kind === "directory" ? (event) => dragOver(event, side, entry.path) : undefined} onDrop={entry.kind === "directory" ? (event) => dropFiles(event, side, entry.path) : undefined}>
            <td className="sftp-check"><Checkbox checked={pane.selected.includes(entry.path)} onCheckedChange={() => toggle(side, entry.path)} aria-label={`Select ${side} ${entry.name}`} /></td>
            <td className="sftp-entry-name"><button type="button" title={entry.path} onClick={(event) => {
              if (event.metaKey || event.ctrlKey) toggle(side, entry.path);
              else updatePane(side, { selected: [entry.path] });
            }} onDoubleClick={(event) => {
              if (event.metaKey || event.ctrlKey || pane.loading) return;
              if (entry.kind === "directory") void list(side, entry.path);
              else if (entry.kind === "file") void openAction("edit", side, entry);
            }} onKeyDown={(event) => {
              if (event.key === "Enter" && entry.kind === "directory" && !pane.loading) { event.preventDefault(); void list(side, entry.path); }
            }}>
              {entry.kind === "directory" ? <FolderIcon className="sftp-folder-icon" /> : entry.kind === "symlink" ? <LinkIcon /> : <FileIcon />}<span>{entry.name}</span>{entry.kind === "symlink" && <span className="sftp-link-label">link</span>}
            </button></td>
            <td className="sftp-size">{entry.kind === "directory" ? "—" : formatBytes(entry.size)}</td>
            <td className="sftp-modified">{entry.modified === null ? "—" : new Date(entry.modified * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })}</td>
            <td className="sftp-mode">{formatPermissions(entry.permissions)}</td>
            <td className="sftp-row-actions"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${side} ${entry.name}`}><EllipsisIcon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
              {entry.kind === "file" && <DropdownMenuItem onSelect={() => void openAction("edit", side, entry)}><FilePenLineIcon />Edit text</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => void openAction("rename", side, entry)}><PencilIcon />Rename</DropdownMenuItem>
              {entry.kind !== "symlink" && (side === "remote" || entry.permissions !== null) && <DropdownMenuItem onSelect={() => void openAction("chmod", side, entry)}><KeyRoundIcon />Permissions</DropdownMenuItem>}
              <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => void openAction("delete", side, entry)}><Trash2Icon />Delete</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu></td>
          </tr>)}</tbody>
        </table>
        {!entries.length && <div className="sftp-pane-empty">{pane.loading ? <><LoaderCircleIcon className="animate-spin" /><p>Loading files…</p></> : <><FolderIcon /><p>{pane.query ? "No matching files" : !pane.loaded ? "Choose a directory to begin" : "This folder is empty"}</p></>}</div>}
      </div>
      <footer className="sftp-pane-footer"><span>{entries.length} items{pane.selected.length > 0 ? ` · ${pane.selected.length} selected` : ""}{pane.selected.length > 0 && !transferEnabled ? " · files and folders only" : ""}</span><Button size="sm" variant={side === "local" ? "default" : "outline"} disabled={!desktop || !transferEnabled || !panes[side === "local" ? "remote" : "local"].loaded || panes.local.loading || panes.remote.loading} onClick={() => enqueue(side === "local" ? "upload" : "download")}>{side === "local" ? <ArrowUpIcon /> : <ArrowDownIcon />}{side === "local" ? "Upload" : "Download"}</Button></footer>
      {isDropTarget && dragSession && <div className="sftp-drop-indicator" role="status">{side === "remote" ? <ArrowUpIcon /> : <ArrowDownIcon />}<span>{side === "remote" ? "Upload" : "Download"} {dragSession.paths.length} {dragSession.paths.length === 1 ? "item" : "items"}<small title={dropTarget.path}>To {dropTarget.path}</small></span></div>}
    </section>;
  }

  const pendingCount = transfers.filter((transfer) => transfer.state === "queued" || transfer.state === "running").length;
  const actionTitle = action ? { mkdir: "New folder", rename: "Rename", delete: "Delete files", chmod: "File permissions", edit: "Edit text file" }[action.kind] : "";
  return <div className="workspace-section sftp-workspace" data-active={active} aria-label="File workspace">
    {!desktop && <div className="sftp-notice" role="status">Open the desktop app to access local files and connect over SFTP.</div>}
    <div className="sftp-options">
      <label className="sftp-mode-control"><span>Transfer mode</span><Select value={mode} onValueChange={(value) => setMode(value as TransferMode)}><SelectTrigger aria-label="Transfer mode" title={mode === "archive" ? "Streams tar/gzip over SSH. Requires tar and gzip on the server. Use SFTP to merge existing folders. No resume." : "Recursively transfers files and folders over SFTP. Symbolic links are not followed."}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="sftp">SFTP</SelectItem><SelectItem value="archive">Archive · gzip over SSH</SelectItem></SelectContent></Select></label>
      <label className="sftp-switch"><Switch checked={showHidden} onCheckedChange={(checked) => { setShowHidden(checked); updatePane("local", { selected: [] }); updatePane("remote", { selected: [] }); }} />Hidden files</label>
      <label className="sftp-switch"><Switch checked={overwrite} onCheckedChange={setOverwrite} />Replace existing files</label>
    </div>
    <div className="sftp-panes">{renderPane("local")}{renderPane("remote")}</div>
    <section className="sftp-transfers" aria-label="Transfer queue">
      <header><h3>Transfers{pendingCount > 0 && <span>{pendingCount} active or queued</span>}</h3>{transfers.some((transfer) => !["running", "queued"].includes(transfer.state)) && <Button size="sm" variant="ghost" onClick={() => setTransfers((current) => current.filter((transfer) => transfer.state === "running" || transfer.state === "queued"))}>Clear finished</Button>}</header>
      {!transfers.length && <p className="sftp-transfer-empty">Select files or folders to upload or download.</p>}
      <div className="sftp-transfer-list" ref={transferList} role="list" aria-label="Transfer history" tabIndex={transfers.length ? 0 : undefined}>
      {transfers.map((transfer) => {
        const percent = transferPercent(transfer.bytes, transfer.total);
        const elapsed = Math.max(1, (transfer.updated - transfer.started) / 1000);
        const detail = transfer.message || transfer.path || `To ${transfer.destination}`;
        return <div className="sftp-transfer" key={transfer.id} data-state={transfer.state} role="listitem" ref={(node) => { if (node) transferRows.current.set(transfer.id, node); else transferRows.current.delete(transfer.id); }}>
          <div className="sftp-transfer-icon">{transfer.state === "completed" ? <CheckCircle2Icon /> : transfer.direction === "upload" ? <ArrowUpIcon /> : <ArrowDownIcon />}</div>
          <div className="sftp-transfer-info"><div className="sftp-transfer-title"><strong>{transfer.direction === "upload" ? "Upload" : "Download"} · {transfer.sources.length === 1 ? transfer.sources[0].split(/[\\/]/).pop() : `${transfer.sources.length} items`}</strong><span>{transfer.mode === "archive" ? "Archive gzip" : "SFTP"} · {transfer.state}</span></div>
            <div className="sftp-transfer-detail"><p title={detail}>{detail}</p><span className="sftp-transfer-stats">{formatBytes(transfer.bytes)}{transfer.total !== null ? ` / ${formatBytes(transfer.total)}` : ""} · {transfer.files} files{transfer.state === "running" && ` · ${formatBytes(transfer.bytes / elapsed)}/s${percent !== null ? ` · ${percent.toFixed(0)}%` : ""}`}</span></div>
          </div>
          {(transfer.state === "running" || transfer.state === "queued") && <Button size="icon-sm" variant="ghost" aria-label={`Cancel ${transfer.direction}`} title="Cancel transfer" onClick={() => void cancelTransfer(transfer)}><XIcon /></Button>}
          {transfer.state === "running" && <div className="sftp-progress" role="progressbar" aria-label="Transfer progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><span className={percent === null ? "sftp-progress-indeterminate" : undefined} style={percent === null ? undefined : { width: `${percent}%` }} /></div>}
        </div>;
      })}
      </div>
    </section>
    <Dialog open={!!action} onOpenChange={(open) => { if (!open && !action?.loading) setAction(null); }}>
      <DialogContent className={action?.kind === "edit" ? "sftp-editor-dialog" : undefined} onEscapeKeyDown={(event) => { if (action?.loading) event.preventDefault(); }} onInteractOutside={(event) => { if (action?.loading) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{actionTitle}</DialogTitle><DialogDescription>{action?.kind === "mkdir" ? `Create a folder in ${panes[action.side].path}` : action?.kind === "delete" ? `Permanently delete ${action.paths.length} selected item${action.paths.length === 1 ? "" : "s"}, including their contents. This cannot be undone.` : action?.paths[0]}</DialogDescription></DialogHeader>
        {action && <form className="sftp-action-form" onSubmit={(event) => void submitAction(event)}>
          {action.kind === "edit" ? <><p className="sftp-help">UTF-8 text files up to 2 MiB. Saving checks that the file has not changed since it was opened.</p><textarea className="sftp-editor" aria-label="File contents" spellCheck={false} value={action.content} disabled={action.loading || !action.revision} onChange={(event) => setAction({ ...action, content: event.target.value })} /></> : action.kind !== "delete" && <label className="sftp-action-field"><span>{action.kind === "chmod" ? "Permissions (octal)" : "Name"}</span><Input autoFocus value={action.value} disabled={action.loading} onChange={(event) => setAction({ ...action, value: event.target.value })} placeholder={action.kind === "chmod" ? "644" : "Folder name"} /></label>}
          {action.kind === "delete" && <ul className="sftp-delete-paths">{action.paths.slice(0, 10).map((path) => <li key={path}>{path}</li>)}{action.paths.length > 10 && <li>…and {action.paths.length - 10} more</li>}</ul>}
          {action.error && <p className="sftp-error" role="alert">{action.error}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={action.loading} onClick={() => setAction(null)}>Cancel</Button><Button variant={action.kind === "delete" ? "destructive" : "default"} disabled={action.loading || (action.kind === "edit" && !action.revision)}>{action.loading && <LoaderCircleIcon className="animate-spin" />}{action.loading ? "Working…" : action.kind === "edit" ? "Save" : action.kind === "delete" ? "Delete permanently" : action.kind === "mkdir" ? "Create folder" : "Apply"}</Button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  </div>;
}
