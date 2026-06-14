import { invoke } from "@tauri-apps/api/core";
import {
  BoxesIcon,
  CheckCircle2Icon,
  EllipsisIcon,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

type AuthConfig =
  | { method: "agent" }
  | { method: "keyFile"; privateKeyPath: string; passphrase?: string | null }
  | { method: "password"; password?: string | null };

type ServerConfig = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthConfig;
  connectTimeoutMs?: number | null;
};

type ForwardKind = "local" | "remote" | "dynamic";

type ForwardConfig = {
  id: string;
  serverId: string;
  name: string;
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  targetHost?: string | null;
  targetPort?: number | null;
  enabled: boolean;
  autoStart: boolean;
  source:
    | { manual: Record<string, never> }
    | { docker: { containerId: string; containerName: string } };
};

type RuntimeState =
  | "starting"
  | "running"
  | "reconnecting"
  | "stopping"
  | "stopped"
  | "failed";

type ForwardRuntimeStatus = {
  forwardId: string;
  state: RuntimeState;
  message?: string | null;
  startedAt?: string | null;
  updatedAt: string;
  reconnects: number;
};

type DockerPort = {
  ip?: string | null;
  privatePort: number;
  publicPort?: number | null;
  protocol: string;
};

type DockerContainer = {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: DockerPort[];
};

type DockerCache = {
  serverId: string;
  fetchedAt: string;
  containers: DockerContainer[];
  lastError?: string | null;
};

type ServerForm = {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: "agent" | "keyFile" | "password";
  privateKeyPath: string;
  passphrase: string;
  password: string;
};

type ForwardForm = {
  name: string;
  kind: ForwardKind;
  bindHost: string;
  bindPort: string;
  targetHost: string;
  targetPort: string;
  autoStart: boolean;
};

type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false };

const emptyServerForm: ServerForm = {
  name: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "agent",
  privateKeyPath: "",
  passphrase: "",
  password: "",
};

const emptyForwardForm: ForwardForm = {
  name: "",
  kind: "local",
  bindHost: "127.0.0.1",
  bindPort: "",
  targetHost: "127.0.0.1",
  targetPort: "",
  autoStart: false,
};

function App() {
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [forwards, setForwards] = useState<ForwardConfig[]>([]);
  const [statuses, setStatuses] = useState<ForwardRuntimeStatus[]>([]);
  const [dockerCache, setDockerCache] = useState<DockerCache | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [forwardDialogOpen, setForwardDialogOpen] = useState(false);
  const [editingForwardId, setEditingForwardId] = useState<string | null>(null);
  const [serverForm, setServerForm] = useState<ServerForm>(emptyServerForm);
  const [forwardForm, setForwardForm] = useState<ForwardForm>(emptyForwardForm);
  const [busy, setBusy] = useState<string | null>(null);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );

  const selectedForwards = useMemo(
    () =>
      selectedServerId
        ? forwards.filter((forward) => forward.serverId === selectedServerId)
        : [],
    [forwards, selectedServerId],
  );

  const statusByForward = useMemo(() => {
    const map = new Map<string, ForwardRuntimeStatus>();
    statuses.forEach((status) => map.set(status.forwardId, status));
    return map;
  }, [statuses]);

  const serverForwardStats = useMemo(() => {
    const stats = new Map<string, { active: number; total: number }>();

    servers.forEach((server) => {
      stats.set(server.id, { active: 0, total: 0 });
    });

    forwards.forEach((forward) => {
      const current = stats.get(forward.serverId) ?? { active: 0, total: 0 };
      current.total += 1;
      if (isForwardActive(statusByForward.get(forward.id)?.state)) {
        current.active += 1;
      }
      stats.set(forward.serverId, current);
    });

    return stats;
  }, [forwards, servers, statusByForward]);

  useEffect(() => {
    void reload().catch((caught) => {
      toast.error("Command failed", {
        description: errorMessage(caught),
      });
    });
  }, []);

  useEffect(() => {
    if (!servers.length) {
      setSelectedServerId(null);
      return;
    }

    if (!selectedServerId || !servers.some((server) => server.id === selectedServerId)) {
      setSelectedServerId(servers[0].id);
    }
  }, [selectedServerId, servers]);

  useEffect(() => {
    if (!selectedServerId) {
      setDockerCache(null);
      return;
    }

    void loadDockerCache(selectedServerId);
  }, [selectedServerId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadStatuses().catch(() => {
        // The Vite browser preview does not expose Tauri IPC.
      });
    }, 1500);

    return () => window.clearInterval(timer);
  }, []);

  async function runAction<T>(
    label: string,
    action: () => Promise<T>,
  ): Promise<ActionResult<T>> {
    setBusy(label);

    try {
      if (!hasTauriRuntime()) {
        throw new Error("Tauri runtime is required for backend commands");
      }
      const result = await action();
      return { ok: true, value: result };
    } catch (caught) {
      toast.error("Command failed", {
        description: errorMessage(caught),
      });
      return { ok: false };
    } finally {
      setBusy(null);
    }
  }

  async function reload() {
    if (!hasTauriRuntime()) {
      setServers([]);
      setForwards([]);
      setStatuses([]);
      return;
    }

    const [servers, forwards, statuses] = await Promise.all([
      invoke<ServerConfig[]>("list_servers"),
      invoke<ForwardConfig[]>("list_forwards", { serverId: null }),
      invoke<ForwardRuntimeStatus[]>("list_forward_statuses"),
    ]);

    setServers(servers);
    setForwards(forwards);
    setStatuses(statuses);
  }

  async function loadStatuses() {
    if (!hasTauriRuntime()) {
      return;
    }

    const statuses = await invoke<ForwardRuntimeStatus[]>("list_forward_statuses");
    setStatuses(statuses);
  }

  async function loadDockerCache(serverId: string) {
    if (!hasTauriRuntime()) {
      setDockerCache(null);
      return;
    }

    const cache = await invoke<DockerCache | null>("list_docker_cache", { serverId });
    setDockerCache(cache);
  }

  function openCreateServerDialog() {
    setEditingServerId(null);
    setServerForm(emptyServerForm);
    setServerDialogOpen(true);
  }

  function openEditServerDialog(server: ServerConfig) {
    setEditingServerId(server.id);
    setServerForm(serverToForm(server));
    setServerDialogOpen(true);
  }

  function openCreateForwardDialog() {
    setEditingForwardId(null);
    setForwardForm(emptyForwardForm);
    setForwardDialogOpen(true);
  }

  function openEditForwardDialog(forward: ForwardConfig) {
    setEditingForwardId(forward.id);
    setForwardForm(forwardToForm(forward));
    setForwardDialogOpen(true);
  }

  async function saveServer(event: FormEvent) {
    event.preventDefault();

    const server: ServerConfig = {
      id: editingServerId ?? "",
      name: serverForm.name.trim(),
      host: serverForm.host.trim(),
      port: Number(serverForm.port) || 22,
      username: serverForm.username.trim(),
      auth: buildAuth(serverForm),
      connectTimeoutMs: 10000,
    };

    const result = await runAction("save-server", () =>
      invoke<ServerConfig>("save_server", { server }),
    );
    if (!result.ok) return;
    const saved = result.value;

    setServerForm(emptyServerForm);
    setEditingServerId(null);
    setServerDialogOpen(false);
    await reload();
    setSelectedServerId(saved.id);
    toast.success("Server saved", {
      description: saved.name,
    });
  }

  async function deleteServer(id: string) {
    const result = await runAction("delete-server", () =>
      invoke("delete_server", { id }),
    );
    if (!result.ok) return;

    if (selectedServerId === id) {
      setSelectedServerId(null);
    }
    await reload();
    setDockerCache(null);
    toast.success("Server deleted");
  }

  async function testSelectedServer() {
    if (!selectedServer) return;

    const result = await runAction("test-server", () =>
      invoke("test_connection", { serverId: selectedServer.id }),
    );
    if (!result.ok) return;

    toast.success("Connected", {
      description: selectedServer.name,
    });
  }

  async function saveForward(event: FormEvent) {
    event.preventDefault();
    if (!selectedServerId) return;

    const existingForward = editingForwardId
      ? forwards.find((forward) => forward.id === editingForwardId)
      : null;
    const wasActive = editingForwardId
      ? isForwardActive(statusByForward.get(editingForwardId)?.state)
      : false;

    if (editingForwardId && wasActive) {
      const stopResult = await runAction(`stop-${editingForwardId}`, () =>
        invoke<ForwardRuntimeStatus>("stop_forward", { id: editingForwardId }),
      );
      if (!stopResult.ok) return;
    }

    const forward: ForwardConfig = {
      id: editingForwardId ?? "",
      serverId: existingForward?.serverId ?? selectedServerId,
      name: forwardForm.name.trim(),
      kind: forwardForm.kind,
      bindHost: forwardForm.bindHost.trim(),
      bindPort: Number(forwardForm.bindPort),
      targetHost:
        forwardForm.kind === "dynamic" ? null : forwardForm.targetHost.trim(),
      targetPort:
        forwardForm.kind === "dynamic" ? null : Number(forwardForm.targetPort),
      enabled: existingForward?.enabled ?? true,
      autoStart: forwardForm.autoStart,
      source: existingForward?.source ?? { manual: {} },
    };

    const result = await runAction("save-forward", () =>
      invoke<ForwardConfig>("save_forward", { forward }),
    );
    if (!result.ok) return;
    const saved = result.value;

    setForwardForm(emptyForwardForm);
    setEditingForwardId(null);
    setForwardDialogOpen(false);
    await reload();
    toast.success("Forward saved", {
      description: saved.name,
    });

    if (saved.autoStart || wasActive) {
      await startForward(saved.id);
    }
  }

  async function deleteForward(id: string) {
    const result = await runAction(`delete-${id}`, () =>
      invoke("delete_forward", { id }),
    );
    if (!result.ok) return;

    await reload();
    toast.success("Forward deleted");
  }

  async function startForward(id: string) {
    const result = await runAction(`start-${id}`, () =>
      invoke<ForwardRuntimeStatus>("start_forward", { id }),
    );
    if (!result.ok) return;

    await loadStatuses();
    if (result.value.state === "failed") {
      toast.error("Tunnel failed", {
        description: result.value.message ?? "Tunnel could not be started",
      });
      return;
    }

    toast.success("Tunnel started");
  }

  async function stopForward(id: string) {
    const result = await runAction(`stop-${id}`, () =>
      invoke<ForwardRuntimeStatus>("stop_forward", { id }),
    );
    if (!result.ok) return;

    await loadStatuses();
    toast.success("Tunnel stopped");
  }

  async function refreshDocker() {
    if (!selectedServerId) return;

    const result = await runAction("refresh-docker", () =>
      invoke<DockerCache>("refresh_docker_containers", {
        serverId: selectedServerId,
      }),
    );
    if (!result.ok) return;
    const cache = result.value;

    setDockerCache(cache);
    if (cache.lastError) {
      toast.error("Docker refresh failed", {
        description: cache.lastError,
      });
    } else {
      toast.success("Docker refreshed", {
        description: `${cache.containers.length} containers cached`,
      });
    }
  }

  async function quickForward(container: DockerContainer, port: DockerPort) {
    if (!selectedServerId || !port.publicPort) return;

    const forward: ForwardConfig = {
      id: "",
      serverId: selectedServerId,
      name: `${container.name}:${port.privatePort}/${port.protocol}`,
      kind: "local",
      bindHost: "127.0.0.1",
      bindPort: port.publicPort,
      targetHost: "127.0.0.1",
      targetPort: port.publicPort,
      enabled: true,
      autoStart: false,
      source: {
        docker: {
          containerId: container.id,
          containerName: container.name,
        },
      },
    };

    const result = await runAction("quick-forward", () =>
      invoke<ForwardConfig>("save_forward", { forward }),
    );
    if (!result.ok) return;
    const saved = result.value;

    await reload();
    toast.success("Forward added", {
      description: saved.name,
    });
  }

  return (
    <TooltipProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "21rem",
          } as CSSProperties
        }
      >
        <Sidebar collapsible="offcanvas">
          <SidebarHeader>
            <div className="flex items-center gap-3 px-2 py-2">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <ServerIcon />
              </div>
              <div className="min-w-0">
                <div className="truncate font-heading text-base font-semibold">
                  Port Forward
                </div>
                <div className="truncate text-sm text-muted-foreground">
                  Native SSH tunnel manager
                </div>
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Servers</SidebarGroupLabel>
              <SidebarGroupContent>
                <ScrollArea className="h-52">
                  {servers.length ? (
                    <SidebarMenu>
                      {servers.map((server) => {
                        const stats = serverForwardStats.get(server.id) ?? {
                          active: 0,
                          total: 0,
                        };
                        return (
                          <SidebarMenuItem key={server.id}>
                            <div className="flex items-center gap-1">
                              <SidebarMenuButton
                                className="min-w-0 flex-1"
                                isActive={server.id === selectedServerId}
                                onClick={() => setSelectedServerId(server.id)}
                              >
                                <PlugIcon />
                                <span className="min-w-0 flex-1 truncate">
                                  {server.name}
                                </span>
                                <Badge
                                  aria-label={serverForwardStatsLabel(stats)}
                                  className="shrink-0 tabular-nums"
                                  variant={stats.active ? "default" : "secondary"}
                                >
                                  {stats.active}/{stats.total}
                                </Badge>
                              </SidebarMenuButton>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    aria-label={`Actions for ${server.name}`}
                                    size="icon-sm"
                                    variant="ghost"
                                  >
                                    <EllipsisIcon />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-44">
                                  <DropdownMenuGroup>
                                    <DropdownMenuLabel>Server</DropdownMenuLabel>
                                    <DropdownMenuItem
                                      onSelect={() => openEditServerDialog(server)}
                                    >
                                      <PencilIcon />
                                      Edit
                                    </DropdownMenuItem>
                                  </DropdownMenuGroup>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuGroup>
                                    <DropdownMenuItem
                                      onSelect={() => {
                                        void deleteServer(server.id);
                                      }}
                                      variant="destructive"
                                    >
                                      <Trash2Icon />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuGroup>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                            <div className="px-8 pb-2 text-xs text-muted-foreground">
                              <span className="block truncate">
                                {server.username}@{server.host}:{server.port}
                              </span>
                              <span className="block truncate">
                                {serverForwardStatsLabel(stats)}
                              </span>
                            </div>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  ) : (
                    <Empty className="min-h-32 border border-dashed">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <ServerIcon />
                        </EmptyMedia>
                        <EmptyTitle>No servers</EmptyTitle>
                        <EmptyDescription>
                          Add a server profile to create tunnels.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                </ScrollArea>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter>
            <Button onClick={openCreateServerDialog}>
              <PlusIcon data-icon="inline-start" />
              Add server
            </Button>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <main className="flex min-h-svh flex-col gap-4 p-4 md:p-6">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <SidebarTrigger className="mt-1 shrink-0" />
                  <div className="min-w-0">
                    <CardDescription>Selected server</CardDescription>
                    <CardTitle className="truncate text-2xl">
                      {selectedServer?.name ?? "No server selected"}
                    </CardTitle>
                    {selectedServer && (
                      <CardDescription className="truncate">
                        {selectedServer.username}@{selectedServer.host}:
                        {selectedServer.port}
                      </CardDescription>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    disabled={!selectedServer || busy === "test-server"}
                    onClick={testSelectedServer}
                    variant="outline"
                  >
                    <CheckCircle2Icon data-icon="inline-start" />
                    Test
                  </Button>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardDescription>Tunnels</CardDescription>
                  <CardTitle>Forwards</CardTitle>
                </div>
                <Button
                  disabled={!selectedServer}
                  onClick={openCreateForwardDialog}
                  variant="outline"
                >
                  <PlusIcon data-icon="inline-start" />
                  Add forward
                </Button>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {selectedForwards.length ? (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Type</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead>Bind</TableHead>
                          <TableHead>Target</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedForwards.map((forward) => {
                          const status = statusByForward.get(forward.id);
                          const active = isForwardActive(status?.state);
                          return (
                            <TableRow key={forward.id}>
                              <TableCell>
                                <Badge variant="secondary">
                                  {kindLabel(forward.kind)}
                                </Badge>
                              </TableCell>
                              <TableCell className="font-medium">
                                {forward.name}
                              </TableCell>
                              <TableCell>
                                {forward.bindHost}:{forward.bindPort}
                              </TableCell>
                              <TableCell>{targetLabel(forward)}</TableCell>
                              <TableCell>
                                <div className="flex flex-col gap-1">
                                  <Badge variant={statusVariant(status?.state)}>
                                    {status?.state ?? "stopped"}
                                  </Badge>
                                  {status?.message && (
                                    <span className="max-w-64 truncate text-xs text-muted-foreground">
                                      {status.message}
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex justify-end gap-2">
                                  <Button
                                    onClick={() => openEditForwardDialog(forward)}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    <PencilIcon data-icon="inline-start" />
                                    Edit
                                  </Button>
                                  <Button
                                    disabled={active}
                                    onClick={() => startForward(forward.id)}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    <PlayIcon data-icon="inline-start" />
                                    Start
                                  </Button>
                                  <Button
                                    disabled={!active}
                                    onClick={() => stopForward(forward.id)}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    <SquareIcon data-icon="inline-start" />
                                    Stop
                                  </Button>
                                  <Button
                                    onClick={() => deleteForward(forward.id)}
                                    size="sm"
                                    type="button"
                                    variant="destructive"
                                  >
                                    <Trash2Icon data-icon="inline-start" />
                                    Delete
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <Empty className="min-h-44 border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <PlugIcon />
                      </EmptyMedia>
                      <EmptyTitle>No forwards for this server</EmptyTitle>
                      <EmptyDescription>
                        Add a local, remote, or dynamic tunnel for this server.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button
                        disabled={!selectedServer}
                        onClick={openCreateForwardDialog}
                        variant="outline"
                      >
                        <PlusIcon data-icon="inline-start" />
                        Add forward
                      </Button>
                    </EmptyContent>
                  </Empty>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardDescription>Docker</CardDescription>
                  <CardTitle>Containers</CardTitle>
                  {dockerCache?.fetchedAt && (
                    <CardDescription>
                      Refreshed {formatTime(dockerCache.fetchedAt)}
                    </CardDescription>
                  )}
                </div>
                <Button
                  disabled={!selectedServer || busy === "refresh-docker"}
                  onClick={refreshDocker}
                  variant="outline"
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  Refresh
                </Button>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {dockerCache?.containers.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Container</TableHead>
                        <TableHead>Image</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Port</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dockerCache.containers.flatMap((container) => {
                        if (!container.ports.length) {
                          return (
                            <TableRow key={`${container.id}-empty`}>
                              <TableCell className="font-medium">
                                {container.name}
                              </TableCell>
                              <TableCell className="max-w-72 truncate">
                                {container.image}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline">{container.status}</Badge>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                No exposed ports
                              </TableCell>
                              <TableCell />
                            </TableRow>
                          );
                        }

                        return container.ports.map((port) => (
                          <TableRow
                            key={`${container.id}-${port.privatePort}-${port.publicPort}-${port.protocol}`}
                          >
                            <TableCell className="font-medium">
                              {container.name}
                            </TableCell>
                            <TableCell className="max-w-72 truncate">
                              {container.image}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{container.status}</Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                <span>
                                  {port.publicPort ?? "-"} {"->"}{" "}
                                  {port.privatePort}/{port.protocol}
                                </span>
                                {port.ip && (
                                  <span className="text-xs text-muted-foreground">
                                    {port.ip}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end">
                                <Button
                                  disabled={!port.publicPort}
                                  onClick={() => quickForward(container, port)}
                                  size="sm"
                                  type="button"
                                  variant="outline"
                                >
                                  <PlusIcon data-icon="inline-start" />
                                  Add
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ));
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <Empty className="min-h-44 border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <BoxesIcon />
                      </EmptyMedia>
                      <EmptyTitle>No cached containers</EmptyTitle>
                      <EmptyDescription>
                        Refresh Docker for the selected server to cache running
                        containers.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button
                        disabled={!selectedServer || busy === "refresh-docker"}
                        onClick={refreshDocker}
                        variant="outline"
                      >
                        <RefreshCwIcon data-icon="inline-start" />
                        Refresh Docker
                      </Button>
                    </EmptyContent>
                  </Empty>
                )}
              </CardContent>
            </Card>
          </main>
        </SidebarInset>
        <ServerDialog
          busy={busy}
          form={serverForm}
          mode={editingServerId ? "edit" : "create"}
          onFormChange={setServerForm}
          onOpenChange={(open) => {
            setServerDialogOpen(open);
            if (!open) {
              setEditingServerId(null);
              setServerForm(emptyServerForm);
            }
          }}
          onSubmit={saveServer}
          open={serverDialogOpen}
        />
        <ForwardDialog
          busy={busy}
          disabled={!selectedServer}
          form={forwardForm}
          mode={editingForwardId ? "edit" : "create"}
          onFormChange={setForwardForm}
          onOpenChange={(open) => {
            setForwardDialogOpen(open);
            if (!open) {
              setEditingForwardId(null);
              setForwardForm(emptyForwardForm);
            }
          }}
          onSubmit={saveForward}
          open={forwardDialogOpen}
        />
        <Toaster closeButton position="bottom-right" richColors theme="dark" />
      </SidebarProvider>
    </TooltipProvider>
  );
}

function ServerDialog({
  busy,
  form,
  mode,
  onFormChange,
  onOpenChange,
  onSubmit,
  open,
}: {
  busy: string | null;
  form: ServerForm;
  mode: "create" | "edit";
  onFormChange: (form: ServerForm) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  open: boolean;
}) {
  const update = <Key extends keyof ServerForm>(
    key: Key,
    value: ServerForm[Key],
  ) => onFormChange({ ...form, [key]: value });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit server" : "Add server"}
          </DialogTitle>
          <DialogDescription>
            Configure the SSH profile used by tunnels and Docker discovery.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="server-name">Name</FieldLabel>
              <Input
                id="server-name"
                onChange={(event) => update("name", event.currentTarget.value)}
                placeholder="Production"
                value={form.name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="server-host">Host</FieldLabel>
              <Input
                id="server-host"
                onChange={(event) => update("host", event.currentTarget.value)}
                placeholder="example.internal"
                required
                value={form.host}
              />
            </Field>
            <div className="grid grid-cols-[1fr_5rem] gap-2">
              <Field>
                <FieldLabel htmlFor="server-user">User</FieldLabel>
                <Input
                  id="server-user"
                  onChange={(event) =>
                    update("username", event.currentTarget.value)
                  }
                  placeholder="deploy"
                  required
                  value={form.username}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="server-port">Port</FieldLabel>
                <Input
                  id="server-port"
                  inputMode="numeric"
                  onChange={(event) => update("port", event.currentTarget.value)}
                  placeholder="22"
                  value={form.port}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="auth-method">Auth</FieldLabel>
              <Select
                name="server-auth-method"
                onValueChange={(value) =>
                  update("authMethod", value as ServerForm["authMethod"])
                }
                value={form.authMethod}
              >
                <SelectTrigger
                  aria-label="Auth"
                  className="w-full"
                  id="auth-method"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="agent">SSH agent</SelectItem>
                    <SelectItem value="keyFile">Key file</SelectItem>
                    <SelectItem value="password">Password</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {form.authMethod === "keyFile" && (
              <>
                <Field>
                  <FieldLabel htmlFor="private-key-path">
                    Private key path
                  </FieldLabel>
                  <Input
                    id="private-key-path"
                    onChange={(event) =>
                      update("privateKeyPath", event.currentTarget.value)
                    }
                    placeholder="~/.ssh/id_ed25519"
                    required
                    value={form.privateKeyPath}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="key-passphrase">Passphrase</FieldLabel>
                  <Input
                    id="key-passphrase"
                    onChange={(event) =>
                      update("passphrase", event.currentTarget.value)
                    }
                    type="password"
                    value={form.passphrase}
                  />
                </Field>
              </>
            )}
            {form.authMethod === "password" && (
              <Field>
                <FieldLabel htmlFor="server-password">Password</FieldLabel>
                <Input
                  id="server-password"
                  onChange={(event) =>
                    update("password", event.currentTarget.value)
                  }
                  required
                  type="password"
                  value={form.password}
                />
              </Field>
            )}
          </FieldGroup>

          <DialogFooter className="mt-4">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={busy === "save-server"} type="submit">
              <PlusIcon data-icon="inline-start" />
              {mode === "edit" ? "Save changes" : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ForwardDialog({
  busy,
  disabled,
  form,
  mode,
  onFormChange,
  onOpenChange,
  onSubmit,
  open,
}: {
  busy: string | null;
  disabled: boolean;
  form: ForwardForm;
  mode: "create" | "edit";
  onFormChange: (form: ForwardForm) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  open: boolean;
}) {
  const update = <Key extends keyof ForwardForm>(
    key: Key,
    value: ForwardForm[Key],
  ) => onFormChange({ ...form, [key]: value });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit forward" : "Add forward"}
          </DialogTitle>
          <DialogDescription>
            Configure local, remote, or dynamic SSH forwarding for the selected
            server.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit}>
          <FieldGroup>
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <Field>
                <FieldLabel htmlFor="forward-dialog-kind">Type</FieldLabel>
                <Select
                  disabled={disabled}
                  name="forward-kind"
                  onValueChange={(value) =>
                    update("kind", value as ForwardKind)
                  }
                  value={form.kind}
                >
                  <SelectTrigger
                    aria-label="Forward type"
                    className="w-full"
                    id="forward-dialog-kind"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="local">-L</SelectItem>
                      <SelectItem value="remote">-R</SelectItem>
                      <SelectItem value="dynamic">-D</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="forward-dialog-name">Name</FieldLabel>
                <Input
                  disabled={disabled}
                  id="forward-dialog-name"
                  onChange={(event) => update("name", event.currentTarget.value)}
                  placeholder="Database"
                  value={form.name}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <Field>
                <FieldLabel htmlFor="forward-dialog-bind-host">
                  Bind host
                </FieldLabel>
                <Input
                  disabled={disabled}
                  id="forward-dialog-bind-host"
                  onChange={(event) =>
                    update("bindHost", event.currentTarget.value)
                  }
                  required
                  value={form.bindHost}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="forward-dialog-bind-port">
                  Bind port
                </FieldLabel>
                <Input
                  disabled={disabled}
                  id="forward-dialog-bind-port"
                  inputMode="numeric"
                  onChange={(event) =>
                    update("bindPort", event.currentTarget.value)
                  }
                  placeholder="5432"
                  required
                  value={form.bindPort}
                />
              </Field>
            </div>
            {form.kind !== "dynamic" && (
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <Field>
                  <FieldLabel htmlFor="forward-dialog-target-host">
                    Target host
                  </FieldLabel>
                  <Input
                    disabled={disabled}
                    id="forward-dialog-target-host"
                    onChange={(event) =>
                      update("targetHost", event.currentTarget.value)
                    }
                    required
                    value={form.targetHost}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="forward-dialog-target-port">
                    Target port
                  </FieldLabel>
                  <Input
                    disabled={disabled}
                    id="forward-dialog-target-port"
                    inputMode="numeric"
                    onChange={(event) =>
                      update("targetPort", event.currentTarget.value)
                    }
                    placeholder="5432"
                    required
                    value={form.targetPort}
                  />
                </Field>
              </div>
            )}
            <Field orientation="horizontal">
              <Checkbox
                checked={form.autoStart}
                disabled={disabled}
                id="forward-dialog-autostart"
                name="forward-autostart"
                onCheckedChange={(checked) =>
                  update("autoStart", checked === true)
                }
              />
              <FieldLabel htmlFor="forward-dialog-autostart">
                Autostart
              </FieldLabel>
            </Field>
          </FieldGroup>

          <DialogFooter className="mt-4">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={disabled || busy === "save-forward"}
              type="submit"
            >
              {mode === "edit" ? (
                <PencilIcon data-icon="inline-start" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              {mode === "edit" ? "Save changes" : "Add forward"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function buildAuth(form: ServerForm): AuthConfig {
  if (form.authMethod === "keyFile") {
    return {
      method: "keyFile",
      privateKeyPath: form.privateKeyPath.trim(),
      passphrase: form.passphrase || null,
    };
  }

  if (form.authMethod === "password") {
    return { method: "password", password: form.password || null };
  }

  return { method: "agent" };
}

function serverToForm(server: ServerConfig): ServerForm {
  const base = {
    ...emptyServerForm,
    name: server.name,
    host: server.host,
    port: String(server.port || 22),
    username: server.username,
  };

  if (server.auth.method === "keyFile") {
    return {
      ...base,
      authMethod: "keyFile",
      privateKeyPath: server.auth.privateKeyPath,
      passphrase: server.auth.passphrase ?? "",
    };
  }

  if (server.auth.method === "password") {
    return {
      ...base,
      authMethod: "password",
      password: server.auth.password ?? "",
    };
  }

  return {
    ...base,
    authMethod: "agent",
  };
}

function forwardToForm(forward: ForwardConfig): ForwardForm {
  return {
    ...emptyForwardForm,
    name: forward.name,
    kind: forward.kind,
    bindHost: forward.bindHost,
    bindPort: String(forward.bindPort || ""),
    targetHost: forward.targetHost ?? emptyForwardForm.targetHost,
    targetPort: forward.targetPort ? String(forward.targetPort) : "",
    autoStart: forward.autoStart,
  };
}

function kindLabel(kind: ForwardKind) {
  if (kind === "local") return "-L";
  if (kind === "remote") return "-R";
  return "-D";
}

function targetLabel(forward: ForwardConfig) {
  if (forward.kind === "dynamic") return "SOCKS";
  return `${forward.targetHost ?? ""}:${forward.targetPort ?? ""}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function statusVariant(state?: RuntimeState) {
  if (state === "failed") return "destructive";
  if (state === "running") return "default";
  if (state === "starting" || state === "reconnecting" || state === "stopping") {
    return "secondary";
  }
  return "outline";
}

function isForwardActive(state?: RuntimeState) {
  return state === "starting" || state === "running" || state === "reconnecting";
}

function serverForwardStatsLabel(stats: { active: number; total: number }) {
  const forwardLabel = stats.total === 1 ? "forward" : "forwards";
  return `${stats.active} active of ${stats.total} ${forwardLabel}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default App;
