import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowDownIcon,
  ArrowLeftRightIcon,
  BoxesIcon,
  CheckCircle2Icon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GlobeIcon,
  KeyRoundIcon,
  NetworkIcon,
  PanelLeftIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SearchIcon,
  ServerIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { OccupiedPortsCard } from "@/components/occupied-ports";
import { NginxWorkspace } from "@/components/nginx-workspace";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const SshTerminal = lazy(() => import("@/components/ssh-terminal").then((module) => ({ default: module.SshTerminal })));

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

type SecretConfig = {
  id: string;
  serverId: string;
  name: string;
  username?: string | null;
  password?: string | null;
  url?: string | null;
  notes?: string | null;
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
  boundHost?: string | null;
  boundPort?: number | null;
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
  serverKey: string;
  fetchedAt: string;
  containers: DockerContainer[];
  lastError?: string | null;
};

type DockerLogStream = "stdout" | "stderr" | "system";

type DockerLogSession = {
  sessionId: string;
  serverId: string;
  containerId: string;
  containerName: string;
  initialLogs: string;
  startedAt: string;
};

type DockerLogChunk = {
  sessionId: string;
  stream: DockerLogStream;
  text: string;
  timestamp: string;
};

type DockerLogStopped = {
  sessionId: string;
  message?: string | null;
  timestamp: string;
};

type DockerLogEntry = DockerLogChunk;

type DockerLogRow = {
  key: string;
  number: number;
  stream: DockerLogStream;
  text: string;
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

type SecretForm = {
  name: string;
  username: string;
  password: string;
  url: string;
  notes: string;
};

type DeleteTarget =
  | { kind: "server"; id: string; name: string }
  | { kind: "forward"; id: string; name: string }
  | { kind: "secret"; id: string; name: string };

type ActionResult<T> = { ok: true; value: T } | { ok: false };

type WorkspaceSection =
  | "forwards"
  | "containers"
  | "ports"
  | "credentials"
  | "nginx"
  | "terminal";

const workspaceSections = [
  { id: "forwards", label: "Forwards", icon: ArrowLeftRightIcon },
  { id: "containers", label: "Containers", icon: BoxesIcon },
  { id: "ports", label: "Ports", icon: NetworkIcon },
  { id: "credentials", label: "Credentials", icon: KeyRoundIcon },
  { id: "nginx", label: "Nginx", icon: GlobeIcon },
  { id: "terminal", label: "Terminal", icon: TerminalIcon },
] as const;

type AnsiTextStyle = Pick<
  CSSProperties,
  | "backgroundColor"
  | "color"
  | "fontStyle"
  | "fontWeight"
  | "opacity"
  | "textDecoration"
>;

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

const emptySecretForm: SecretForm = {
  name: "",
  username: "",
  password: "",
  url: "",
  notes: "",
};

function App() {
  const [activeSection, setActiveSection] =
    useState<WorkspaceSection>("forwards");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [serverQuery, setServerQuery] = useState("");
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [nginxNewRequest, setNginxNewRequest] = useState(0);
  const [nginxBusy, setNginxBusy] = useState(false);
  const [terminalRevision, setTerminalRevision] = useState(0);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [secrets, setSecrets] = useState<SecretConfig[]>([]);
  const [forwards, setForwards] = useState<ForwardConfig[]>([]);
  const [statuses, setStatuses] = useState<ForwardRuntimeStatus[]>([]);
  const [dockerCache, setDockerCache] = useState<DockerCache | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [forwardDialogOpen, setForwardDialogOpen] = useState(false);
  const [editingForwardId, setEditingForwardId] = useState<string | null>(null);
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [serverForm, setServerForm] = useState<ServerForm>(emptyServerForm);
  const [forwardForm, setForwardForm] = useState<ForwardForm>(emptyForwardForm);
  const [secretForm, setSecretForm] = useState<SecretForm>(emptySecretForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [logContainer, setLogContainer] = useState<DockerContainer | null>(
    null,
  );
  const [logSession, setLogSession] = useState<DockerLogSession | null>(null);
  const [logLines, setLogLines] = useState<DockerLogEntry[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const activeLogSessionIdRef = useRef<string | null>(null);
  const selectedServerIdRef = useRef<string | null>(null);

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

  const selectedSecrets = useMemo(
    () =>
      selectedServerId
        ? secrets.filter((secret) => secret.serverId === selectedServerId)
        : [],
    [secrets, selectedServerId],
  );

  const selectedServerCacheKey = useMemo(
    () => (selectedServer ? dockerCacheKey(selectedServer) : null),
    [selectedServer],
  );

  const selectedDockerCache = useMemo(
    () =>
      dockerCache?.serverId === selectedServerId &&
      dockerCache.serverKey === selectedServerCacheKey
        ? dockerCache
        : null,
    [dockerCache, selectedServerCacheKey, selectedServerId],
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

    if (
      !selectedServerId ||
      !servers.some((server) => server.id === selectedServerId)
    ) {
      setSelectedServerId(servers[0].id);
    }
  }, [selectedServerId, servers]);

  useEffect(() => {
    selectedServerIdRef.current = selectedServerId;
  }, [selectedServerId]);

  useEffect(() => {
    setWorkspaceQuery("");
    if (activeSection === "terminal") setTerminalOpened(true);
  }, [activeSection, selectedServerId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat)
        return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return;
      // Ctrl shortcuts belong to the remote shell while its input has focus.
      if (event.ctrlKey && !event.metaKey && event.target instanceof Element && event.target.closest(".xterm"))
        return;

      const sectionIndex = [
        "Digit1",
        "Digit2",
        "Digit3",
        "Digit4",
        "Digit5",
        "Digit6",
      ].indexOf(event.code);
      if (sectionIndex >= 0) {
        event.preventDefault();
        setActiveSection(workspaceSections[sectionIndex].id);
      } else if (event.code === "KeyB") {
        event.preventDefault();
        setSidebarOpen((open) => !open);
      } else if (event.code === "KeyF") {
        const input = document.querySelector<HTMLInputElement>(
          `#workspace-${activeSection} input[type="search"]`,
        );
        if (input) {
          event.preventDefault();
          input.focus();
          input.select();
        }
      } else if (event.code === "KeyN") {
        event.preventDefault();
        if (nginxBusy) return;
        if (event.shiftKey || !selectedServerId) openCreateServerDialog();
        else if (activeSection === "credentials") openCreateSecretDialog();
        else if (activeSection === "nginx")
          setNginxNewRequest((request) => request + 1);
        else if (activeSection === "terminal") return;
        else openCreateForwardDialog();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeSection, selectedServerId, nginxBusy]);

  useEffect(() => {
    if (!selectedServerId) {
      setDockerCache(null);
      return;
    }

    setDockerCache(null);
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

  useEffect(() => {
    if (!hasTauriRuntime()) {
      return;
    }

    let disposed = false;
    const unlistenFns: UnlistenFn[] = [];

    void listen<DockerLogChunk>("docker-log-chunk", (event) => {
      if (event.payload.sessionId !== activeLogSessionIdRef.current) {
        return;
      }

      setLogLines((current) => [...current, event.payload].slice(-5000));
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenFns.push(unlisten);
      }
    });

    void listen<DockerLogStopped>("docker-log-stopped", (event) => {
      if (event.payload.sessionId !== activeLogSessionIdRef.current) {
        return;
      }

      const sessionId = event.payload.sessionId;
      activeLogSessionIdRef.current = null;
      setLogSession(null);
      void invoke("stop_container_logs", { sessionId });

      if (event.payload.message) {
        setLogError(event.payload.message);
        toast.error("Docker logs stopped", {
          description: event.payload.message,
        });
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenFns.push(unlisten);
      }
    });

    return () => {
      disposed = true;
      unlistenFns.forEach((unlisten) => unlisten());

      const sessionId = activeLogSessionIdRef.current;
      if (sessionId) {
        activeLogSessionIdRef.current = null;
        void invoke("stop_container_logs", { sessionId });
      }
    };
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
      setSecrets([]);
      setForwards([]);
      setStatuses([]);
      return;
    }

    const [servers, secrets, forwards, statuses] = await Promise.all([
      invoke<ServerConfig[]>("list_servers"),
      invoke<SecretConfig[]>("list_secrets", { serverId: null }),
      invoke<ForwardConfig[]>("list_forwards", { serverId: null }),
      invoke<ForwardRuntimeStatus[]>("list_forward_statuses"),
    ]);

    setServers(servers);
    setSecrets(secrets);
    setForwards(forwards);
    setStatuses(statuses);
  }

  async function loadStatuses() {
    if (!hasTauriRuntime()) {
      return;
    }

    const statuses = await invoke<ForwardRuntimeStatus[]>(
      "list_forward_statuses",
    );
    setStatuses(statuses);
  }

  async function loadDockerCache(serverId: string) {
    if (!hasTauriRuntime()) {
      setDockerCache(null);
      return;
    }

    const cache = await invoke<DockerCache | null>("list_docker_cache", {
      serverId,
    });
    if (selectedServerIdRef.current === serverId) {
      setDockerCache(cache?.serverId === serverId ? cache : null);
    }
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

  function openCreateSecretDialog() {
    setEditingSecretId(null);
    setSecretForm(emptySecretForm);
    setSecretDialogOpen(true);
  }

  function openEditForwardDialog(forward: ForwardConfig) {
    setEditingForwardId(forward.id);
    setForwardForm(forwardToForm(forward));
    setForwardDialogOpen(true);
  }

  function openEditSecretDialog(secret: SecretConfig) {
    setEditingSecretId(secret.id);
    setSecretForm(secretToForm(secret));
    setSecretDialogOpen(true);
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

    setTerminalRevision((revision) => revision + 1);
    setServerForm(emptyServerForm);
    setEditingServerId(null);
    setServerDialogOpen(false);
    await reload();
    setSelectedServerId(saved.id);
    setDockerCache(null);
    void loadDockerCache(saved.id);
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

  async function testServer(server: ServerConfig) {
    if (!server) return;

    const result = await runAction(`test-server-${server.id}`, () =>
      invoke("test_connection", { serverId: server.id }),
    );
    if (!result.ok) return;

    toast.success("Connected", {
      description: server.name,
    });
  }

  async function saveSecret(event: FormEvent) {
    event.preventDefault();
    if (!selectedServerId) return;

    const existingSecret = editingSecretId
      ? secrets.find((secret) => secret.id === editingSecretId)
      : null;

    const secret: SecretConfig = {
      id: editingSecretId ?? "",
      serverId: existingSecret?.serverId ?? selectedServerId,
      name: secretForm.name.trim(),
      username: nullableText(secretForm.username),
      password: nullableText(secretForm.password),
      url: nullableText(secretForm.url),
      notes: nullableText(secretForm.notes),
    };

    const result = await runAction("save-secret", () =>
      invoke<SecretConfig>("save_secret", { secret }),
    );
    if (!result.ok) return;
    const saved = result.value;

    setSecretForm(emptySecretForm);
    setEditingSecretId(null);
    setSecretDialogOpen(false);
    await reload();
    toast.success("Credential saved", {
      description: saved.name,
    });
  }

  async function deleteSecret(id: string) {
    const result = await runAction(`delete-secret-${id}`, () =>
      invoke("delete_secret", { id }),
    );
    if (!result.ok) return;

    await reload();
    toast.success("Credential deleted");
  }

  async function copySecretValue(label: string, value?: string | null) {
    if (!value) return;

    try {
      await copyText(value);
      toast.success(`${label} copied`);
    } catch (caught) {
      toast.error("Copy failed", {
        description: errorMessage(caught),
      });
    }
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

  async function confirmPendingDelete() {
    const target = pendingDelete;
    if (!target) return;

    setPendingDelete(null);
    if (target.kind === "server") {
      await deleteServer(target.id);
      return;
    }
    if (target.kind === "secret") {
      await deleteSecret(target.id);
      return;
    }
    await deleteForward(target.id);
  }

  async function startForward(id: string) {
    const configuredForward = forwards.find((forward) => forward.id === id);
    const result = await runAction(`start-${id}`, () =>
      invoke<ForwardRuntimeStatus>("start_forward", { id }),
    );
    if (!result.ok) return;

    await loadStatuses();
    const status = result.value;
    if (status.state === "failed") {
      toast.error("Tunnel failed", {
        description: status.message ?? "Tunnel could not be started",
      });
      return;
    }

    if (
      configuredForward &&
      status.boundPort &&
      status.boundPort !== configuredForward.bindPort
    ) {
      toast.success("Tunnel started on a temporary port", {
        description: `Port ${configuredForward.bindPort} is busy, using ${status.boundPort}`,
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

  async function openForwardInBrowser(
    forward: ForwardConfig,
    status?: ForwardRuntimeStatus,
  ) {
    const url = forwardBrowserUrl(forward, status);
    if (!hasTauriRuntime()) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    const result = await runAction(`open-${forward.id}`, () => openUrl(url));
    if (!result.ok) return;

    toast.success("Browser opened", {
      description: url,
    });
  }

  async function refreshDocker() {
    const serverId = selectedServerId;
    if (!serverId) return;

    const result = await runAction("refresh-docker", () =>
      invoke<DockerCache>("refresh_docker_containers", {
        serverId,
      }),
    );
    if (!result.ok) return;
    const cache = result.value;

    if (selectedServerIdRef.current === serverId) {
      setDockerCache(cache.serverId === serverId ? cache : null);
    }
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

  async function openContainerLogs(container: DockerContainer) {
    if (!selectedServerId) return;

    await stopCurrentContainerLogs();
    setLogContainer(container);
    setLogLines([]);
    setLogError(null);
    setLogSession(null);
    setLogDialogOpen(true);

    const result = await runAction(`logs-${container.id}`, () =>
      invoke<DockerLogSession>("start_container_logs", {
        serverId: selectedServerId,
        containerId: container.id,
        containerName: container.name,
      }),
    );

    if (!result.ok) {
      setLogDialogOpen(false);
      setLogContainer(null);
      return;
    }

    const session = result.value;
    activeLogSessionIdRef.current = session.sessionId;
    setLogSession(session);
    setLogLines(logTextToEntries(session));
  }

  async function stopCurrentContainerLogs() {
    const sessionId = activeLogSessionIdRef.current ?? logSession?.sessionId;

    activeLogSessionIdRef.current = null;
    setLogSession(null);

    if (!sessionId || !hasTauriRuntime()) {
      return;
    }

    try {
      await invoke("stop_container_logs", { sessionId });
    } catch (caught) {
      toast.error("Command failed", {
        description: errorMessage(caught),
      });
    }
  }

  function setContainerLogsOpen(open: boolean) {
    setLogDialogOpen(open);
    if (!open) {
      void stopCurrentContainerLogs();
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

  const search = workspaceQuery.trim().toLowerCase();
  const visibleServers = servers.filter((server) =>
    `${server.name} ${server.host} ${server.username}`
      .toLowerCase()
      .includes(serverQuery.trim().toLowerCase()),
  );
  const visibleForwards = selectedForwards.filter((forward) =>
    `${forward.name} ${kindLabel(forward.kind)} ${bindLabel(forward, statusByForward.get(forward.id))} ${targetLabel(forward)}`
      .toLowerCase()
      .includes(search),
  );
  const visibleContainers = (selectedDockerCache?.containers ?? []).filter(
    (container) =>
      `${container.name} ${container.image} ${container.ports.map((port) => `${port.publicPort ?? ""} ${port.privatePort} ${port.protocol}`).join(" ")}`
        .toLowerCase()
        .includes(search),
  );
  const visibleSecrets = selectedSecrets.filter((secret) =>
    `${secret.name} ${secret.username ?? ""} ${secret.url ?? ""} ${secret.notes ?? ""}`
      .toLowerCase()
      .includes(search),
  );
  const activeCount = selectedForwards.filter((forward) =>
    isForwardActive(statusByForward.get(forward.id)?.state),
  ).length;
  const activeTotal = statuses.filter((status) =>
    isForwardActive(status.state),
  ).length;
  const sectionLabel = workspaceSections.find(
    (section) => section.id === activeSection,
  )!.label;

  return (
    <TooltipProvider>
      <div className="app-shell" data-sidebar={sidebarOpen ? "open" : "closed"}>
        <aside
          aria-label="Server navigation"
          className="app-sidebar"
          hidden={!sidebarOpen}
        >
          <div className="sidebar-titlebar" data-tauri-drag-region />
          <div className="sidebar-brand" data-tauri-drag-region>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
              <ArrowLeftRightIcon className="size-4" />
            </span>
            <span>Port Forward</span>
            <Button
              aria-label="Hide sidebar"
              className="ml-auto"
              onClick={() => setSidebarOpen(false)}
              size="icon-sm"
              title="Hide sidebar (⌘B)"
              variant="ghost"
            >
              <PanelLeftIcon />
            </Button>
          </div>
          <nav aria-label="Workspace" className="px-3 py-3">
            {workspaceSections.map(({ id, label, icon: Icon }, index) => (
              <button
                aria-current={activeSection === id ? "page" : undefined}
                className="sidebar-nav-item"
                data-active={activeSection === id}
                key={id}
                onClick={() => setActiveSection(id)}
                title={`${label} (⌘${index + 1})`}
                type="button"
              >
                <Icon aria-hidden="true" className="size-4" />
                <span>{label}</span>
                {id === "forwards" && selectedForwards.length > 0 && (
                  <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                    {selectedForwards.length}
                  </span>
                )}
                {id === "containers" &&
                  !!selectedDockerCache?.containers.length && (
                    <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                      {selectedDockerCache.containers.length}
                    </span>
                  )}
              </button>
            ))}
          </nav>
          <div className="flex items-center justify-between px-5 pt-3 pb-2">
            <span className="sidebar-section-label">
              Servers{" "}
              <span className="ml-1 tabular-nums">{servers.length}</span>
            </span>
            <Button
              aria-label="Add server"
              disabled={nginxBusy}
              onClick={openCreateServerDialog}
              size="icon-sm"
              title="Add server (⇧⌘N)"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </div>
          <div className="sidebar-search relative mx-3 mb-2">
            <SearchIcon aria-hidden="true" />
            <Input
              aria-label="Find a server"
              className="pl-8"
              onChange={(event) => setServerQuery(event.target.value)}
              placeholder="Find a server…"
              type="search"
              value={serverQuery}
            />
          </div>
          <div className="server-list">
            {visibleServers.map((server) => {
              const stats = serverForwardStats.get(server.id) ?? {
                active: 0,
                total: 0,
              };
              return (
                <div
                  className="server-row"
                  data-active={server.id === selectedServerId}
                  key={server.id}
                >
                  <button
                    aria-label={`Select ${server.name}`}
                    aria-pressed={server.id === selectedServerId}
                    className="server-selection"
                    disabled={nginxBusy}
                    onClick={() => setSelectedServerId(server.id)}
                    type="button"
                  >
                    <span className="server-avatar">
                      <ServerIcon aria-hidden="true" className="size-4" />
                    </span>
                    <span className="server-meta">
                      <span className="truncate font-medium">
                        {server.name}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {server.host}
                      </span>
                    </span>
                    {stats.active > 0 && (
                      <span
                        aria-label={serverForwardStatsLabel(stats)}
                        className="connection-dot shrink-0"
                        data-state="running"
                        title={serverForwardStatsLabel(stats)}
                      />
                    )}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={`Actions for ${server.name}`}
                        disabled={nginxBusy}
                        size="icon-sm"
                        title={`Actions for ${server.name}`}
                        variant="ghost"
                      >
                        <EllipsisIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>{server.name}</DropdownMenuLabel>
                      <DropdownMenuItem
                        disabled={busy === `test-server-${server.id}`}
                        onSelect={() => void testServer(server)}
                      >
                        <CheckCircle2Icon />
                        Test connection
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => openEditServerDialog(server)}
                      >
                        <PencilIcon />
                        Edit server…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() =>
                          setPendingDelete({
                            kind: "server",
                            id: server.id,
                            name: server.name,
                          })
                        }
                        variant="destructive"
                      >
                        <Trash2Icon />
                        Delete server…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
            {!visibleServers.length && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {servers.length
                  ? "No matching servers"
                  : "Add your first SSH server."}
              </p>
            )}
          </div>
          <div className="sidebar-bottom">
            <span
              className="status-indicator"
              data-state={activeTotal ? "running" : "stopped"}
            />
            <span>
              {activeTotal
                ? `${activeTotal} active ${activeTotal === 1 ? "tunnel" : "tunnels"}`
                : "No active tunnels"}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              SSH
            </span>
          </div>
        </aside>

        <div className="workspace">
          <header className="window-toolbar">
            {!sidebarOpen && (
              <Button
                aria-label="Show sidebar"
                onClick={() => setSidebarOpen(true)}
                size="icon-sm"
                title="Show sidebar (⌘B)"
                variant="ghost"
              >
                <PanelLeftIcon />
              </Button>
            )}
            <div className="min-w-0">
              <div className="toolbar-title">
                {selectedServer?.name ?? "Port Forward"}
                <span className="mx-2 font-normal text-muted-foreground/50">
                  /
                </span>
                <span className="font-normal text-muted-foreground">
                  {sectionLabel}
                </span>
              </div>
              <div className="toolbar-subtitle">
                {selectedServer
                  ? `${selectedServer.username}@${selectedServer.host}:${selectedServer.port}`
                  : "SSH workspaces"}
              </div>
            </div>
            <div
              aria-hidden="true"
              className="min-w-4 flex-1 self-stretch"
              data-tauri-drag-region
            />
            {selectedServer && (
              <div className="toolbar-actions">
                <Button
                  disabled={busy === `test-server-${selectedServer.id}`}
                  onClick={() => void testServer(selectedServer)}
                  size="sm"
                  variant="ghost"
                >
                  <CheckCircle2Icon data-icon="inline-start" />
                  {busy === `test-server-${selectedServer.id}`
                    ? "Connecting…"
                    : "Test connection"}
                </Button>
                <span className="toolbar-divider" />
                <Button
                  aria-label={`Edit ${selectedServer.name}`}
                  disabled={nginxBusy}
                  onClick={() => openEditServerDialog(selectedServer)}
                  size="icon-sm"
                  title="Server settings"
                  variant="ghost"
                >
                  <EllipsisIcon />
                </Button>
              </div>
            )}
          </header>

          <main className="workspace-content" data-terminal={activeSection === "terminal" && !!selectedServer}>
            {!selectedServer ? (
              <div className="empty-workspace">
                <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-muted">
                  <ArrowLeftRightIcon className="size-7 text-muted-foreground" />
                </div>
                <p className="workspace-eyebrow">Port Forward</p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight">
                  Connect to your first server
                </h1>
                <p className="mt-3 max-w-sm text-center leading-relaxed text-muted-foreground">
                  Add an SSH server to manage tunnels, containers, and ports.
                </p>
                <Button className="mt-6" onClick={openCreateServerDialog}>
                  <PlusIcon data-icon="inline-start" />
                  Add your first server
                </Button>
                <span className="mt-3 text-xs text-muted-foreground">⇧⌘N</span>
              </div>
            ) : (
              <>
                <section
                  aria-label="Forwards"
                  className="workspace-section"
                  hidden={activeSection !== "forwards"}
                  id="workspace-forwards"
                >
                  <div className="workspace-heading">
                    <div>
                      <p className="workspace-eyebrow">SSH tunnels</p>
                      <h1>Forwards</h1>
                      <p className="mt-1 text-muted-foreground">
                        Local, remote, and SOCKS tunnels for{" "}
                        {selectedServer.name}.
                      </p>
                    </div>
                    <Button
                      onClick={openCreateForwardDialog}
                      title="New forward (⌘N)"
                    >
                      <PlusIcon data-icon="inline-start" />
                      New forward
                    </Button>
                  </div>
                  <div className="workspace-summary">
                    <span className="stat-item">
                      <span className="stat-value">
                        {selectedForwards.length}
                      </span>
                      <span className="stat-label">total</span>
                    </span>
                    <span className="stat-item">
                      <span className="status-indicator" data-state="running" />
                      <span className="stat-value">{activeCount}</span>
                      <span className="stat-label">active</span>
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {selectedServer.host}
                    </span>
                  </div>
                  <WorkspaceSearch
                    label="Search forwards"
                    onChange={setWorkspaceQuery}
                    placeholder="Find a forward…"
                    value={workspaceQuery}
                  />
                  {visibleForwards.length ? (
                    <div className="native-table">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Bind address</TableHead>
                            <TableHead>Destination</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">
                              <span className="sr-only">Actions</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visibleForwards.map((forward) => {
                            const status = statusByForward.get(forward.id);
                            const active = isForwardActive(status?.state);
                            return (
                              <TableRow key={forward.id}>
                                <TableCell>
                                  <div className="name-cell">
                                    <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                      <ArrowLeftRightIcon className="size-4" />
                                    </span>
                                    <div className="min-w-0">
                                      <span className="font-medium">
                                        {forward.name}
                                      </span>
                                      <div className="row-subtitle">
                                        {kindLabel(forward.kind)} ·{" "}
                                        {forward.source &&
                                        "docker" in forward.source
                                          ? "Docker"
                                          : forward.kind === "dynamic"
                                            ? "SOCKS proxy"
                                            : `${forward.kind} forward`}
                                      </div>
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <span className="endpoint">
                                    {bindLabel(forward, status)}
                                  </span>
                                  {isUsingRuntimeBind(forward, status) && (
                                    <div className="row-subtitle">
                                      Configured {forward.bindHost}:
                                      {forward.bindPort}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell className="endpoint">
                                  {targetLabel(forward)}
                                </TableCell>
                                <TableCell>
                                  <span className="status-label">
                                    <span
                                      className="status-indicator"
                                      data-state={status?.state ?? "stopped"}
                                    />
                                    {status?.state ?? "stopped"}
                                  </span>
                                  {status?.message && (
                                    <div
                                      className="row-subtitle max-w-56 whitespace-normal"
                                      title={status.message}
                                    >
                                      {status.message}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <div className="row-actions">
                                    {forward.kind === "local" && (
                                      <Button
                                        aria-label={`Open ${forward.name} in browser`}
                                        className="open-forward-action"
                                        disabled={!active}
                                        onClick={() =>
                                          void openForwardInBrowser(
                                            forward,
                                            status,
                                          )
                                        }
                                        size="icon-sm"
                                        title="Open in browser"
                                        variant="ghost"
                                      >
                                        <ExternalLinkIcon />
                                      </Button>
                                    )}
                                    <Button
                                      aria-label={`${active ? "Stop" : "Start"} ${forward.name}`}
                                      disabled={
                                        busy === `start-${forward.id}` ||
                                        busy === `stop-${forward.id}`
                                      }
                                      onClick={() =>
                                        void (active
                                          ? stopForward(forward.id)
                                          : startForward(forward.id))
                                      }
                                      size="sm"
                                      variant="outline"
                                    >
                                      {active ? (
                                        <SquareIcon data-icon="inline-start" />
                                      ) : (
                                        <PlayIcon data-icon="inline-start" />
                                      )}
                                      {active ? "Stop" : "Start"}
                                    </Button>
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button
                                          aria-label={`Actions for ${forward.name}`}
                                          size="icon-sm"
                                          title="More actions"
                                          variant="ghost"
                                        >
                                          <EllipsisIcon />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        {forward.kind === "local" && (
                                          <DropdownMenuItem
                                            disabled={!active}
                                            onSelect={() =>
                                              void openForwardInBrowser(
                                                forward,
                                                status,
                                              )
                                            }
                                          >
                                            <ExternalLinkIcon />
                                            Open in browser
                                          </DropdownMenuItem>
                                        )}
                                        <DropdownMenuItem
                                          onSelect={() =>
                                            openEditForwardDialog(forward)
                                          }
                                        >
                                          <PencilIcon />
                                          Edit forward…
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                          onSelect={() =>
                                            setPendingDelete({
                                              kind: "forward",
                                              id: forward.id,
                                              name: forward.name,
                                            })
                                          }
                                          variant="destructive"
                                        >
                                          <Trash2Icon />
                                          Delete forward…
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <WorkspaceEmpty
                      description={
                        search
                          ? "Try a different name, address, or port."
                          : "Create a tunnel to reach a service through this server."
                      }
                      icon={<ArrowLeftRightIcon />}
                      onAction={
                        search
                          ? () => setWorkspaceQuery("")
                          : openCreateForwardDialog
                      }
                      action={search ? "Clear search" : "New forward"}
                      title={
                        search ? "No matching forwards" : "No forwards yet"
                      }
                    />
                  )}
                </section>

                <section
                  aria-label="Containers"
                  className="workspace-section"
                  hidden={activeSection !== "containers"}
                  id="workspace-containers"
                >
                  <div className="workspace-heading">
                    <div>
                      <p className="workspace-eyebrow">Docker workspace</p>
                      <h1>Containers</h1>
                      <p className="mt-1 text-muted-foreground">
                        Published ports and live logs, a click away.
                      </p>
                    </div>
                    <Button
                      disabled={busy === "refresh-docker"}
                      onClick={() => void refreshDocker()}
                      variant="outline"
                    >
                      <RefreshCwIcon
                        className={
                          busy === "refresh-docker" ? "animate-spin" : undefined
                        }
                        data-icon="inline-start"
                      />
                      {busy === "refresh-docker" ? "Refreshing…" : "Refresh"}
                    </Button>
                  </div>
                  <div className="workspace-summary">
                    <span className="stat-item">
                      <span className="stat-value">
                        {selectedDockerCache?.containers.length ?? 0}
                      </span>
                      <span className="stat-label">containers</span>
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {selectedDockerCache?.fetchedAt
                        ? `Updated ${formatTime(selectedDockerCache.fetchedAt)}`
                        : "Not scanned yet"}
                    </span>
                  </div>
                  {selectedDockerCache?.lastError && (
                    <p
                      className="rounded-lg bg-destructive/5 px-3 py-2 text-destructive"
                      role="alert"
                    >
                      {selectedDockerCache.lastError}
                    </p>
                  )}
                  <WorkspaceSearch
                    label="Search containers"
                    onChange={setWorkspaceQuery}
                    placeholder="Find a container or port…"
                    value={workspaceQuery}
                  />
                  {visibleContainers.length ? (
                    <div className="native-table">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Container</TableHead>
                            <TableHead>Published ports</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">
                              <span className="sr-only">Actions</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visibleContainers.map((container) => (
                            <TableRow key={container.id}>
                              <TableCell>
                                <div className="name-cell">
                                  <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                    <BoxesIcon className="size-4" />
                                  </span>
                                  <div className="min-w-0">
                                    <span className="font-medium">
                                      {container.name}
                                    </span>
                                    <div
                                      className="row-subtitle max-w-72 truncate"
                                      title={container.image}
                                    >
                                      {container.image}
                                    </div>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                {container.ports.length ? (
                                  <div className="flex flex-col gap-2">
                                    {uniqueDockerPorts(container.ports).map(
                                      (port) => (
                                        <div
                                          className="flex items-center gap-2"
                                          key={`${port.ip}-${port.privatePort}-${port.publicPort}-${port.protocol}`}
                                        >
                                          <span
                                            className="endpoint"
                                            title={
                                              port.ip
                                                ? `Bind address: ${port.ip}`
                                                : undefined
                                            }
                                          >
                                            {port.publicPort
                                              ? `${port.publicPort} → `
                                              : ""}
                                            {port.privatePort}/{port.protocol}
                                          </span>
                                          {port.ip &&
                                            port.ip !== "0.0.0.0" &&
                                            port.ip !== "::" && (
                                              <span className="endpoint text-[11px] text-muted-foreground">
                                                {port.ip}
                                              </span>
                                            )}
                                          {!port.publicPort && (
                                            <span className="text-[11px] text-muted-foreground">
                                              Not published
                                            </span>
                                          )}
                                          <Button
                                            aria-label={`Forward ${container.name} port ${port.publicPort ?? port.privatePort}`}
                                            disabled={!port.publicPort}
                                            onClick={() =>
                                              void quickForward(container, port)
                                            }
                                            size="icon-sm"
                                            title="Add local forward"
                                            variant="ghost"
                                          >
                                            <PlusIcon />
                                          </Button>
                                        </div>
                                      ),
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">
                                    No exposed ports
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <span className="status-label">
                                  <span
                                    className="status-indicator"
                                    data-state={
                                      container.status === "running"
                                        ? "running"
                                        : "stopped"
                                    }
                                  />
                                  {container.status}
                                </span>
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  aria-label={`View logs for ${container.name}`}
                                  disabled={busy === `logs-${container.id}`}
                                  onClick={() =>
                                    void openContainerLogs(container)
                                  }
                                  size="sm"
                                  variant="ghost"
                                >
                                  <ScrollTextIcon data-icon="inline-start" />
                                  Logs
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <WorkspaceEmpty
                      action={search ? "Clear search" : "Refresh containers"}
                      description={
                        search
                          ? "Try a different name, image, or port."
                          : "Refresh to discover running containers on this server."
                      }
                      icon={<BoxesIcon />}
                      onAction={
                        search
                          ? () => setWorkspaceQuery("")
                          : () => void refreshDocker()
                      }
                      title={
                        search
                          ? "No matching containers"
                          : "No containers cached"
                      }
                    />
                  )}
                </section>

                <div hidden={activeSection !== "ports"} id="workspace-ports">
                  <OccupiedPortsCard
                    key={`${selectedServerId}-${selectedServerCacheKey}`}
                    serverId={selectedServer.id}
                    serverKey={selectedServerCacheKey ?? undefined}
                  />
                </div>

                <section
                  aria-label="Credentials"
                  className="workspace-section"
                  hidden={activeSection !== "credentials"}
                  id="workspace-credentials"
                >
                  <div className="workspace-heading">
                    <div>
                      <p className="workspace-eyebrow">Quick access</p>
                      <h1>Credentials</h1>
                      <p className="mt-1 text-muted-foreground">
                        Connection details for your databases and services.
                      </p>
                    </div>
                    <Button onClick={openCreateSecretDialog}>
                      <PlusIcon data-icon="inline-start" />
                      New credential
                    </Button>
                  </div>
                  <div className="workspace-summary">
                    <span className="stat-item">
                      <span className="stat-value">
                        {selectedSecrets.length}
                      </span>
                      <span className="stat-label">
                        saved{" "}
                        {selectedSecrets.length === 1
                          ? "credential"
                          : "credentials"}
                      </span>
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      Stored locally
                    </span>
                  </div>
                  <WorkspaceSearch
                    label="Search credentials"
                    onChange={setWorkspaceQuery}
                    placeholder="Find a credential…"
                    value={workspaceQuery}
                  />
                  {visibleSecrets.length ? (
                    <div className="native-table">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Username</TableHead>
                            <TableHead>Password</TableHead>
                            <TableHead>URL</TableHead>
                            <TableHead className="text-right">
                              <span className="sr-only">Actions</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visibleSecrets.map((secret) => (
                            <TableRow key={secret.id}>
                              <TableCell>
                                <span className="font-medium">
                                  {secret.name}
                                </span>
                                {secret.notes && (
                                  <div
                                    className="row-subtitle max-w-52 truncate"
                                    title={secret.notes}
                                  >
                                    {secret.notes}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>
                                <SecretValue
                                  label="Username"
                                  onCopy={() =>
                                    void copySecretValue(
                                      "Username",
                                      secret.username,
                                    )
                                  }
                                  value={secret.username}
                                />
                              </TableCell>
                              <TableCell>
                                <SecretValue
                                  label="Password"
                                  masked
                                  onCopy={() =>
                                    void copySecretValue(
                                      "Password",
                                      secret.password,
                                    )
                                  }
                                  value={secret.password}
                                />
                              </TableCell>
                              <TableCell>
                                <SecretValue
                                  label="URL"
                                  onCopy={() =>
                                    void copySecretValue("URL", secret.url)
                                  }
                                  value={secret.url}
                                />
                              </TableCell>
                              <TableCell>
                                <div className="row-actions">
                                  <Button
                                    aria-label={`Edit ${secret.name}`}
                                    onClick={() => openEditSecretDialog(secret)}
                                    size="icon-sm"
                                    title="Edit credential"
                                    variant="ghost"
                                  >
                                    <PencilIcon />
                                  </Button>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        aria-label={`Actions for ${secret.name}`}
                                        size="icon-sm"
                                        title="More actions"
                                        variant="ghost"
                                      >
                                        <EllipsisIcon />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        onSelect={() =>
                                          setPendingDelete({
                                            kind: "secret",
                                            id: secret.id,
                                            name: secret.name,
                                          })
                                        }
                                        variant="destructive"
                                      >
                                        <Trash2Icon />
                                        Delete credential…
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <WorkspaceEmpty
                      action={search ? "Clear search" : "New credential"}
                      description={
                        search
                          ? "Try a different name, username, or URL."
                          : "Keep database and service details ready to copy."
                      }
                      icon={<KeyRoundIcon />}
                      onAction={
                        search
                          ? () => setWorkspaceQuery("")
                          : openCreateSecretDialog
                      }
                      title={
                        search
                          ? "No matching credentials"
                          : "No credentials yet"
                      }
                    />
                  )}
                </section>
                <div hidden={activeSection !== "nginx"} id="workspace-nginx">
                  <NginxWorkspace
                    key={`${selectedServerId}-${selectedServerCacheKey}`}
                    serverId={selectedServer.id}
                    serverKey={selectedServerCacheKey ?? ""}
                    serverName={selectedServer.name}
                    newRequest={nginxNewRequest}
                    onMutatingChange={setNginxBusy}
                  />
                </div>
                <div hidden={activeSection !== "terminal"} id="workspace-terminal">
                  {(terminalOpened || activeSection === "terminal") && (
                    <Suspense fallback={<p className="text-xs text-muted-foreground" role="status">Loading terminal…</p>}>
                      <SshTerminal
                        key={`${selectedServer.id}-${selectedServerCacheKey}-${terminalRevision}`}
                        serverId={selectedServer.id}
                        endpoint={`${selectedServer.username}@${selectedServer.host}:${selectedServer.port}`}
                        active={activeSection === "terminal"}
                      />
                    </Suspense>
                  )}
                </div>
              </>
            )}
          </main>
          <footer className="app-statusbar">
            <span>
              {nginxBusy
                ? "Nginx operation in progress…"
                : selectedServer
                  ? `${selectedForwards.length} forwards · ${activeCount} active`
                  : "Ready when you are"}
            </span>
            <span className="ml-auto">
              {selectedServer
                ? `SSH · ${selectedServer.host}`
                : "Local workspace"}
            </span>
          </footer>
        </div>
      </div>
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
      <SecretDialog
        busy={busy}
        disabled={!selectedServer}
        form={secretForm}
        mode={editingSecretId ? "edit" : "create"}
        onFormChange={setSecretForm}
        onOpenChange={(open) => {
          setSecretDialogOpen(open);
          if (!open) {
            setEditingSecretId(null);
            setSecretForm(emptySecretForm);
          }
        }}
        onSubmit={saveSecret}
        open={secretDialogOpen}
      />
      <ConfirmDeleteDialog
        onConfirm={() => {
          void confirmPendingDelete();
        }}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        target={pendingDelete}
      />
      <ContainerLogsDialog
        container={logContainer}
        error={logError}
        lines={logLines}
        onOpenChange={setContainerLogsOpen}
        open={logDialogOpen}
        session={logSession}
      />
      <Toaster closeButton position="bottom-right" richColors theme="system" />
    </TooltipProvider>
  );
}

function WorkspaceSearch({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative mb-1 max-w-sm">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        aria-label={label}
        className="pl-8"
        data-workspace-search
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </div>
  );
}

function WorkspaceEmpty({
  title,
  description,
  icon,
  action,
  onAction,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  action: string;
  onAction: () => void;
}) {
  return (
    <Empty className="min-h-72">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onAction} size="sm" variant="outline">
          {action}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function ConfirmDeleteDialog({
  onConfirm,
  onOpenChange,
  target,
}: {
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  target: DeleteTarget | null;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={Boolean(target)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{deleteDialogTitle(target)}</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteDialogDescription(target)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} variant="destructive">
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ContainerLogsDialog({
  container,
  error,
  lines,
  onOpenChange,
  open,
  session,
}: {
  container: DockerContainer | null;
  error: string | null;
  lines: DockerLogEntry[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  session: DockerLogSession | null;
}) {
  const status = session ? "Live" : error ? "Stopped" : "Loading";
  const rows = useMemo(() => dockerLogRows(lines), [lines]);
  const [followTail, setFollowTail] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setFollowTail(true);
    setShowScrollToBottom(false);
    scheduleScrollLogsToBottom("auto");
  }, [open, session?.sessionId]);

  useEffect(() => {
    if (!open || !followTail) {
      return;
    }

    scheduleScrollLogsToBottom("auto");
  }, [followTail, lines.length, open, wrapLines]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!open || !viewport) {
      return;
    }

    const handleScroll = () => {
      const atBottom = isLogViewportAtBottom(viewport);
      setFollowTail(atBottom);
      setShowScrollToBottom(!atBottom);
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
    };
  }, [open, session?.sessionId]);

  function scrollLogsToBottom(behavior: ScrollBehavior = "smooth") {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTo({
      behavior,
      top: viewport.scrollHeight,
    });
    setFollowTail(true);
    setShowScrollToBottom(false);
  }

  function scheduleScrollLogsToBottom(behavior: ScrollBehavior = "auto") {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => scrollLogsToBottom(behavior));
    });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollTextIcon className="size-4" />
            Logs: {container?.name ?? "Container"}
          </DialogTitle>
          <DialogDescription>
            {container
              ? `${container.image} · ${container.id}`
              : "Docker container logs"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                session ? "default" : error ? "destructive" : "secondary"
              }
            >
              {status}
            </Badge>
            {container?.status && (
              <Badge variant="outline">{container.status}</Badge>
            )}
            {session?.startedAt && (
              <span className="text-xs text-muted-foreground">
                Started {formatTime(session.startedAt)}
              </span>
            )}
          </div>
          <Field className="ml-auto gap-2" orientation="horizontal">
            <Switch
              checked={wrapLines}
              id="logs-wrap-lines"
              onCheckedChange={setWrapLines}
              size="sm"
            />
            <FieldLabel htmlFor="logs-wrap-lines">Wrap lines</FieldLabel>
          </Field>
        </div>

        <div className="relative min-w-0 max-w-full">
          <ScrollArea
            className="min-w-0 max-w-full overflow-hidden rounded-lg border bg-muted/30 h-[min(65vh,32rem)]"
            scrollbars="both"
            viewportRef={viewportRef}
          >
            <div
              className={cn(
                "min-h-full font-mono text-xs leading-relaxed",
                wrapLines ? "min-w-0" : "min-w-max",
              )}
            >
              {rows.length ? (
                rows.map((row) => (
                  <div
                    className={cn(
                      "group/log-row grid border-b border-border/30 hover:bg-muted/60",
                      wrapLines
                        ? "grid-cols-[4.25rem_minmax(0,1fr)]"
                        : "grid-cols-[4.25rem_auto] min-w-max",
                    )}
                    data-log-row=""
                    key={row.key}
                  >
                    <span className="select-none border-r border-border/30 bg-muted/20 px-2 py-0.5 text-right tabular-nums text-muted-foreground group-hover/log-row:text-foreground">
                      {row.number}
                    </span>
                    <code
                      className={cn(
                        "block min-w-0 px-3 py-0.5",
                        dockerLogStreamClass(row.stream),
                        wrapLines
                          ? "whitespace-pre-wrap break-all [overflow-wrap:anywhere]"
                          : "whitespace-pre",
                      )}
                    >
                      {renderAnsiText(row.text, row.key)}
                    </code>
                  </div>
                ))
              ) : (
                <div className="p-3 text-muted-foreground">
                  {session ? "Waiting for logs..." : "Loading logs..."}
                </div>
              )}
              {error && (
                <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] border-b border-border/30 text-destructive">
                  <span className="select-none border-r border-border/30 bg-muted/20 px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                    !
                  </span>
                  <code className="block min-w-0 px-3 py-0.5 whitespace-pre-wrap break-all [overflow-wrap:anywhere]">
                    {error}
                  </code>
                </div>
              )}
            </div>
          </ScrollArea>
          {showScrollToBottom && (
            <Button
              className="absolute right-4 bottom-4 shadow-lg"
              onClick={() => scrollLogsToBottom("smooth")}
              size="sm"
              type="button"
              variant="secondary"
            >
              <ArrowDownIcon data-icon="inline-start" />
              Bottom
            </Button>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretValue({
  label,
  masked,
  onCopy,
  value,
}: {
  label: string;
  masked?: boolean;
  onCopy: () => void;
  value?: string | null;
}) {
  if (!value) {
    return <span className="text-muted-foreground">-</span>;
  }

  return (
    <div className="flex max-w-56 items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-sm">
        {masked ? "••••••••" : value}
      </span>
      <Button
        aria-label={`Copy ${label}`}
        onClick={onCopy}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <CopyIcon />
      </Button>
    </div>
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
                  onChange={(event) =>
                    update("port", event.currentTarget.value)
                  }
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

function SecretDialog({
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
  form: SecretForm;
  mode: "create" | "edit";
  onFormChange: (form: SecretForm) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  open: boolean;
}) {
  const update = <Key extends keyof SecretForm>(
    key: Key,
    value: SecretForm[Key],
  ) => onFormChange({ ...form, [key]: value });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit credential" : "New credential"}
          </DialogTitle>
          <DialogDescription>
            Store credentials for database admin tools and related services.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="secret-name">Name</FieldLabel>
              <Input
                disabled={disabled}
                id="secret-name"
                onChange={(event) => update("name", event.currentTarget.value)}
                placeholder="phpMyAdmin"
                required
                value={form.name}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="secret-username">Username</FieldLabel>
                <Input
                  disabled={disabled}
                  id="secret-username"
                  onChange={(event) =>
                    update("username", event.currentTarget.value)
                  }
                  placeholder="root"
                  value={form.username}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="secret-password">Password</FieldLabel>
                <Input
                  disabled={disabled}
                  id="secret-password"
                  onChange={(event) =>
                    update("password", event.currentTarget.value)
                  }
                  type="password"
                  value={form.password}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="secret-url">URL</FieldLabel>
              <Input
                disabled={disabled}
                id="secret-url"
                onChange={(event) => update("url", event.currentTarget.value)}
                placeholder="http://127.0.0.1:50000"
                value={form.url}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-notes">Notes</FieldLabel>
              <Input
                disabled={disabled}
                id="secret-notes"
                onChange={(event) => update("notes", event.currentTarget.value)}
                placeholder="database, host, or short hint"
                value={form.notes}
              />
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
            <Button disabled={disabled || busy === "save-secret"} type="submit">
              {mode === "edit" ? (
                <PencilIcon data-icon="inline-start" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              {mode === "edit" ? "Save changes" : "Add credential"}
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
                  onChange={(event) =>
                    update("name", event.currentTarget.value)
                  }
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

function dockerCacheKey(server: ServerConfig) {
  return `${server.username.trim()}@${server.host.trim()}:${server.port}`;
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

function secretToForm(secret: SecretConfig): SecretForm {
  return {
    name: secret.name,
    username: secret.username ?? "",
    password: secret.password ?? "",
    url: secret.url ?? "",
    notes: secret.notes ?? "",
  };
}

function deleteDialogTitle(target: DeleteTarget | null) {
  if (!target) return "Delete item?";
  if (target.kind === "server") return `Delete server "${target.name}"?`;
  if (target.kind === "secret") return `Delete credential "${target.name}"?`;
  return `Delete forward "${target.name}"?`;
}

function deleteDialogDescription(target: DeleteTarget | null) {
  if (!target) return "This action cannot be undone.";
  if (target.kind === "server") {
    return "This will remove the server, its forwards, Docker cache, and saved credentials. Running tunnels for this server will be stopped.";
  }
  if (target.kind === "secret") {
    return "This will remove the saved credential from local storage. This action cannot be undone.";
  }
  return "This will stop the tunnel if it is running and remove the forward from local storage. This action cannot be undone.";
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

function effectiveBindHost(
  forward: ForwardConfig,
  status?: ForwardRuntimeStatus,
) {
  return status?.boundHost ?? forward.bindHost;
}

function effectiveBindPort(
  forward: ForwardConfig,
  status?: ForwardRuntimeStatus,
) {
  return status?.boundPort ?? forward.bindPort;
}

function bindLabel(forward: ForwardConfig, status?: ForwardRuntimeStatus) {
  return `${effectiveBindHost(forward, status)}:${effectiveBindPort(forward, status)}`;
}

function isUsingRuntimeBind(
  forward: ForwardConfig,
  status?: ForwardRuntimeStatus,
) {
  return (
    Boolean(status?.boundPort) &&
    (status?.boundHost !== forward.bindHost ||
      status?.boundPort !== forward.bindPort)
  );
}

function forwardBrowserUrl(
  forward: ForwardConfig,
  status?: ForwardRuntimeStatus,
) {
  const host = browserHost(effectiveBindHost(forward, status));
  return `http://${host}:${effectiveBindPort(forward, status)}`;
}

function browserHost(host: string) {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host || "127.0.0.1";
}

function uniqueDockerPorts(ports: DockerPort[]) {
  const unique = new Map<string, DockerPort>();

  for (const port of ports) {
    // Docker lists a dual-stack wildcard binding once for each IP family.
    const host = port.ip === "::" ? "0.0.0.0" : (port.ip ?? "");
    const key = JSON.stringify([
      host,
      port.publicPort,
      port.privatePort,
      port.protocol,
    ]);

    if (!unique.has(key) || port.ip === "0.0.0.0") {
      unique.set(key, port);
    }
  }

  return [...unique.values()];
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function isForwardActive(state?: RuntimeState) {
  return (
    state === "starting" || state === "running" || state === "reconnecting"
  );
}

function serverForwardStatsLabel(stats: { active: number; total: number }) {
  const forwardLabel = stats.total === 1 ? "forward" : "forwards";
  return `${stats.active} active of ${stats.total} ${forwardLabel}`;
}

function logTextToEntries(session: DockerLogSession): DockerLogEntry[] {
  if (!session.initialLogs) {
    return [];
  }

  return [
    {
      sessionId: session.sessionId,
      stream: "stdout",
      text: session.initialLogs,
      timestamp: session.startedAt,
    },
  ];
}

function dockerLogRows(entries: DockerLogEntry[]): DockerLogRow[] {
  const rows: DockerLogRow[] = [];
  let currentText = "";
  let currentStream: DockerLogStream = entries[0]?.stream ?? "stdout";

  const flush = () => {
    rows.push({
      key: `log-row-${rows.length + 1}`,
      number: rows.length + 1,
      stream: currentStream,
      text: currentText,
    });
    currentText = "";
  };

  entries.forEach((entry) => {
    const parts = entry.text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");

    parts.forEach((part, index) => {
      if (index > 0) {
        flush();
        currentStream = entry.stream;
      }

      if (!currentText) {
        currentStream = entry.stream;
      }
      currentText += part;
    });
  });

  if (currentText) {
    flush();
  }

  return rows;
}

function isLogViewportAtBottom(viewport: HTMLElement) {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32
  );
}

function dockerLogStreamClass(stream: DockerLogStream) {
  if (stream === "system") return "text-destructive";
  if (stream === "stderr") return "text-amber-400";
  return "text-foreground";
}

function renderAnsiText(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const style: AnsiTextStyle = {};
  const csiPattern = /\x1b\[([0-?]*)([ -/]*)([@-~])/g;
  let lastIndex = 0;
  let segmentIndex = 0;

  csiPattern.lastIndex = 0;

  for (
    let match = csiPattern.exec(text);
    match;
    match = csiPattern.exec(text)
  ) {
    pushAnsiTextSegment(
      nodes,
      text.slice(lastIndex, match.index),
      style,
      `${keyPrefix}-${segmentIndex}`,
    );
    segmentIndex += 1;

    if (match[3] === "m") {
      applyAnsiCodes(style, parseAnsiCodes(match[1]));
    }

    lastIndex = match.index + match[0].length;
  }

  pushAnsiTextSegment(
    nodes,
    text.slice(lastIndex),
    style,
    `${keyPrefix}-${segmentIndex}`,
  );

  return nodes;
}

function pushAnsiTextSegment(
  nodes: ReactNode[],
  text: string,
  style: AnsiTextStyle,
  key: string,
) {
  if (!text) {
    return;
  }

  nodes.push(
    <span
      key={key}
      style={Object.keys(style).length ? { ...style } : undefined}
    >
      {text}
    </span>,
  );
}

function parseAnsiCodes(params: string) {
  if (!params) {
    return [0];
  }

  return params.split(";").map((param) => Number(param || 0));
}

function applyAnsiCodes(style: AnsiTextStyle, codes: number[]) {
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;

    if (code === 0) {
      clearAnsiStyle(style);
    } else if (code === 1) {
      style.fontWeight = 700;
    } else if (code === 2) {
      style.opacity = 0.72;
    } else if (code === 3) {
      style.fontStyle = "italic";
    } else if (code === 4) {
      style.textDecoration = "underline";
    } else if (code === 22) {
      delete style.fontWeight;
      delete style.opacity;
    } else if (code === 23) {
      delete style.fontStyle;
    } else if (code === 24) {
      delete style.textDecoration;
    } else if (code === 39) {
      delete style.color;
    } else if (code === 49) {
      delete style.backgroundColor;
    } else if (code >= 30 && code <= 37) {
      style.color = ansiBasicColor(code - 30);
    } else if (code >= 90 && code <= 97) {
      style.color = ansiBasicColor(code - 90 + 8);
    } else if (code >= 40 && code <= 47) {
      style.backgroundColor = ansiBasicColor(code - 40);
    } else if (code >= 100 && code <= 107) {
      style.backgroundColor = ansiBasicColor(code - 100 + 8);
    } else if (code === 38 || code === 48) {
      const result = readExtendedAnsiColor(codes, index + 1);
      if (result) {
        if (code === 38) {
          style.color = result.color;
        } else {
          style.backgroundColor = result.color;
        }
        index = result.nextIndex;
      }
    }
  }
}

function clearAnsiStyle(style: AnsiTextStyle) {
  delete style.backgroundColor;
  delete style.color;
  delete style.fontStyle;
  delete style.fontWeight;
  delete style.opacity;
  delete style.textDecoration;
}

function readExtendedAnsiColor(codes: number[], index: number) {
  const mode = codes[index];

  if (mode === 5) {
    const color = ansi256Color(codes[index + 1]);
    return color ? { color, nextIndex: index + 1 } : null;
  }

  if (mode === 2) {
    const [red, green, blue] = codes.slice(index + 1, index + 4);
    if ([red, green, blue].every(isRgbChannel)) {
      return {
        color: `rgb(${red}, ${green}, ${blue})`,
        nextIndex: index + 3,
      };
    }
  }

  return null;
}

function ansiBasicColor(index: number) {
  const colors = [
    "#0f172a",
    "#ef4444",
    "#22c55e",
    "#eab308",
    "#3b82f6",
    "#d946ef",
    "#06b6d4",
    "#e5e7eb",
    "#64748b",
    "#f87171",
    "#4ade80",
    "#facc15",
    "#60a5fa",
    "#e879f9",
    "#22d3ee",
    "#f8fafc",
  ];

  return colors[index] ?? colors[7];
}

function ansi256Color(value?: number) {
  if (
    value === undefined ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 255
  ) {
    return null;
  }

  if (value < 16) {
    return ansiBasicColor(value);
  }

  if (value >= 232) {
    const level = 8 + (value - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }

  const levels = [0, 95, 135, 175, 215, 255];
  const offset = value - 16;
  const red = levels[Math.floor(offset / 36)];
  const green = levels[Math.floor(offset / 6) % 6];
  const blue = levels[offset % 6];

  return `rgb(${red}, ${green}, ${blue})`;
}

function isRgbChannel(value: number | undefined) {
  return (
    value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255
  );
}

function nullableText(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy was rejected");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default App;
