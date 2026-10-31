import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckCircle2Icon,
  CopyIcon,
  EllipsisIcon,
  FileCode2Icon,
  GlobeIcon,
  LockKeyholeIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  cloneSiteConfig,
  createDomainDraft,
  DEFAULT_NGINX_SETTINGS,
  generateDomainConfig,
  isValidDomain,
  isValidNginxFileName,
  parseDomainAliases,
  validateDomainDraft,
  validateNginxSettings,
  type DomainDraft,
  type NginxOperationResult,
  type NginxSettings,
  type NginxSite,
  type NginxSiteSummary,
  type NginxSnapshot,
} from "@/lib/nginx";
import "./nginx-workspace.css";

const NginxCodeEditor = lazy(() => import("./nginx-code-editor"));

type Editor = {
  kind: "new" | "edit" | "duplicate";
  step: "setup" | "configuration";
  fileName: string;
  content: string;
  enabled: boolean;
  revision: string | null;
  source: NginxSite | null;
  draft: DomainDraft;
  forceRenewal: boolean;
  previewKey: string | null;
  dirty: boolean;
};

type OperationLog = NginxOperationResult & { title: string };

function settingsStorageKey(serverKey: string) {
  return `port-forward.nginx-settings.${serverKey}`;
}

function loadSettings(serverKey: string): NginxSettings {
  try {
    const saved = JSON.parse(
      localStorage.getItem(settingsStorageKey(serverKey)) ?? "null",
    ) as Partial<NginxSettings> | null;
    if (saved) {
      const candidate = { ...DEFAULT_NGINX_SETTINGS, ...saved };
      if (!validateNginxSettings(candidate).length) return candidate;
    }
  } catch {
    // Settings remain usable when browser storage is unavailable.
  }
  return { ...DEFAULT_NGINX_SETTINGS };
}

function newEditor(): Editor {
  return {
    kind: "new",
    step: "setup",
    fileName: "",
    content: "",
    enabled: false,
    revision: null,
    source: null,
    draft: createDomainDraft(),
    forceRenewal: false,
    previewKey: null,
    dirty: false,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function configurationKey(draft: DomainDraft, settings: NginxSettings) {
  return JSON.stringify({ draft: { ...draft, email: "" }, settings });
}

export function NginxWorkspace({
  serverId,
  serverKey,
  serverName,
  newRequest = 0,
  onMutatingChange,
}: {
  serverId: string;
  serverKey: string;
  serverName: string;
  newRequest?: number;
  onMutatingChange?: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<NginxSettings>(() =>
    loadSettings(serverKey),
  );
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsErrors, setSettingsErrors] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<NginxSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationLog | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorErrors, setEditorErrors] = useState<string[]>([]);
  const [discardAction, setDiscardAction] = useState<"close" | "new" | null>(
    null,
  );
  const generation = useRef(0);
  const busyRef = useRef(false);
  const previousNewRequest = useRef(newRequest);
  const mutatingCallback = useRef(onMutatingChange);
  mutatingCallback.current = onMutatingChange;

  useEffect(
    () => () => {
      generation.current += 1;
      mutatingCallback.current?.(false);
    },
    [],
  );

  useEffect(() => {
    if (newRequest === previousNewRequest.current) return;
    previousNewRequest.current = newRequest;
    if (busyRef.current) return;
    if (editor?.dirty) setDiscardAction("new");
    else {
      setEditor(newEditor());
      setEditorErrors([]);
      setError(null);
      setOperation(null);
    }
  }, [newRequest, editor?.dirty]);

  async function perform<T>(
    label: string,
    command: string,
    args: Record<string, unknown> = {},
    mutating = false,
  ): Promise<T | undefined> {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    const request = ++generation.current;
    setBusy(label);
    setError(null);
    if (mutating) mutatingCallback.current?.(true);

    try {
      const result = await invoke<T>(command, { serverId, settings, ...args });
      return request === generation.current ? result : undefined;
    } catch (caught) {
      if (request === generation.current)
        setError(
          mutating
            ? `${errorMessage(caught)} The operation result could not be confirmed. Refresh the site list before retrying.`
            : errorMessage(caught),
        );
      return undefined;
    } finally {
      if (request === generation.current) {
        busyRef.current = false;
        setBusy(null);
        if (mutating) mutatingCallback.current?.(false);
      }
    }
  }

  async function refresh() {
    const result = await perform<NginxSnapshot>("refresh", "list_nginx_sites");
    if (!result) return;
    if (result.serverId !== serverId || result.serverKey !== serverKey) {
      setError("Server settings changed. Refresh the domain list again.");
      return;
    }
    setSnapshot(result);
  }

  async function runOperation(
    label: string,
    command: string,
    args: Record<string, unknown> = {},
    closeEditor = false,
    mutating = true,
  ) {
    setOperation(null);
    const result = await perform<NginxOperationResult>(
      label,
      command,
      args,
      mutating,
    );
    if (!result) return;
    setOperation({ ...result, title: label });
    if (result.success) {
      if (closeEditor) {
        setEditor(null);
        setEditorErrors([]);
      }
      if (mutating) await refresh();
    }
  }

  function openNew() {
    if (busyRef.current) return;
    if (editor?.dirty) {
      setDiscardAction("new");
      return;
    }
    setEditor(newEditor());
    setEditorErrors([]);
    setError(null);
    setOperation(null);
  }

  async function openSite(site: NginxSiteSummary, duplicate: boolean) {
    const result = await perform<NginxSite>(
      `read-${site.fileName}`,
      "read_nginx_site",
      { fileName: site.fileName },
    );
    if (!result) return;
    const draft = createDomainDraft();
    draft.domain = duplicate ? "" : (result.domains[0] ?? "");
    draft.aliases = duplicate ? "" : result.domains.slice(1).join(" ");
    setEditor({
      kind: duplicate ? "duplicate" : "edit",
      step: "configuration",
      fileName: duplicate ? `copy-${result.fileName}` : result.fileName,
      content: result.content,
      enabled: duplicate ? false : result.enabled,
      revision: duplicate ? null : result.revision,
      source: result,
      draft,
      forceRenewal: false,
      previewKey: null,
      dirty: false,
    });
    setEditorErrors([]);
    setOperation(null);
  }

  function updateEditor(patch: Partial<Editor>) {
    setEditor((current) =>
      current ? { ...current, ...patch, dirty: true } : current,
    );
    setEditorErrors([]);
  }

  function updateDraft(patch: Partial<DomainDraft>) {
    if (!editor) return;
    const nextDraft = { ...editor.draft, ...patch };
    const automaticName =
      !editor.fileName || editor.fileName === `${editor.draft.domain}.conf`;
    updateEditor({
      draft: nextDraft,
      ...(editor.kind === "new" && automaticName && patch.domain !== undefined
        ? { fileName: patch.domain.trim() ? `${patch.domain.trim()}.conf` : "" }
        : {}),
    });
  }

  function previewConfiguration() {
    if (!editor) return;
    const errors = validateDomainDraft(editor.draft, settings);
    if (errors.length) {
      setEditorErrors(errors);
      return;
    }
    try {
      const previewKey = configurationKey(editor.draft, settings);
      updateEditor({
        content:
          editor.previewKey === previewKey && editor.content.trim()
            ? editor.content
            : generateDomainConfig(editor.draft, settings),
        step: "configuration",
        previewKey,
      });
    } catch (caught) {
      setEditorErrors([errorMessage(caught)]);
    }
  }

  function replaceCopiedDomain() {
    if (!editor?.source) return;
    try {
      const content = cloneSiteConfig(
        { ...editor.source, content: editor.content },
        editor.draft.domain.trim(),
      );
      const primary = editor.source.domains.find(isValidDomain)?.toLowerCase();
      const domain = editor.draft.domain.trim().toLowerCase();
      const aliases = editor.source.domains
        .filter(isValidDomain)
        .map((name) => {
          const normalized = name.toLowerCase();
          if (normalized === primary) return domain;
          return primary && normalized.endsWith(`.${primary}`)
            ? `${normalized.slice(0, -primary.length)}${domain}`
            : normalized;
        })
        .filter((name) => name !== domain);
      updateEditor({
        content,
        fileName:
          editor.fileName === `copy-${editor.source.fileName}` ||
          editor.fileName === `${primary}.conf`
            ? `${domain}.conf`
            : editor.fileName,
        draft: { ...editor.draft, domain, aliases: aliases.join(" ") },
        source: { ...editor.source, content, domains: [domain, ...aliases] },
      });
    } catch (caught) {
      setEditorErrors([errorMessage(caught)]);
    }
  }

  function editorValidation(provision: boolean) {
    if (!editor) return ["Open a configuration first."];
    const errors: string[] = [];
    if (!isValidNginxFileName(editor.fileName))
      errors.push(
        "Use a filename of at most 200 characters containing letters, numbers, dots, hyphens, or underscores, without parent-directory sequences.",
      );
    if (!editor.content.trim()) errors.push("Configuration cannot be empty.");
    if (provision) {
      if (
        editor.kind === "edit" &&
        editor.source?.enabled &&
        editor.source.hasTls
      )
        errors.push(
          "Use Save & apply for an enabled HTTPS site. Certificate setup is available for new or disabled sites.",
        );
      errors.push(...validateDomainDraft(editor.draft, settings));
      if (!editor.draft.email.trim())
        errors.push("Enter an email address for the certificate.");
    }
    return errors;
  }

  async function saveEditor(provision: boolean) {
    if (!editor) return;
    const errors = editorValidation(provision);
    if (errors.length) {
      setEditorErrors(errors);
      return;
    }
    const create = editor.kind !== "edit";
    const base = {
      fileName: editor.fileName,
      content: editor.content,
      create,
      expectedRevision: editor.revision,
    };
    if (provision) {
      await runOperation(
        "Issue certificate & enable HTTPS",
        "provision_nginx_site",
        {
          request: {
            ...base,
            domain: editor.draft.domain.trim().toLowerCase(),
            aliases: parseDomainAliases(editor.draft.aliases),
            email: editor.draft.email.trim(),
            forceRenewal: editor.forceRenewal,
          },
        },
        true,
      );
    } else {
      await runOperation(
        create
          ? "Save disabled draft"
          : editor.enabled
            ? "Save & apply configuration"
            : "Save disabled configuration",
        "save_nginx_site",
        { request: { ...base, enabled: create ? false : editor.enabled } },
        true,
      );
    }
  }

  function closeEditor() {
    if (busyRef.current) return;
    if (editor?.dirty) setDiscardAction("close");
    else {
      setEditor(null);
      setEditorErrors([]);
    }
  }

  function saveSettings() {
    const errors = validateNginxSettings(settingsDraft);
    if (errors.length) {
      setSettingsErrors(errors);
      return;
    }
    generation.current += 1;
    setSettings({ ...settingsDraft });
    try {
      localStorage.setItem(
        settingsStorageKey(serverKey),
        JSON.stringify(settingsDraft),
      );
    } catch {
      /* Optional preference persistence. */
    }
    setSnapshot(null);
    setOperation(null);
    setError(null);
    setSettingsOpen(false);
  }

  const search = query.trim().toLowerCase();
  const sites =
    snapshot?.sites.filter((site) =>
      `${site.fileName} ${site.domains.join(" ")}`
        .toLowerCase()
        .includes(search),
    ) ?? [];
  const provisioning = busy === "Issue certificate & enable HTTPS";
  const existingLiveTls = !!(
    editor?.kind === "edit" &&
    editor.source?.enabled &&
    editor.source.hasTls
  );

  return (
    <section aria-label="Nginx" className="workspace-section nginx-workspace">
      <header className="workspace-heading">
        <div>
          <p className="workspace-eyebrow">Domains & reverse proxies</p>
          <h1>Nginx</h1>
          <p className="mt-1 text-muted-foreground">
            Configure domains and HTTPS on {serverName}.
          </p>
        </div>
        <div className="nginx-header-actions">
          <Button
            aria-label="Nginx settings"
            disabled={!!busy}
            onClick={() => {
              setSettingsDraft(settings);
              setSettingsErrors([]);
              setSettingsOpen(true);
            }}
            size="icon-sm"
            title="Nginx settings"
            variant="ghost"
          >
            <Settings2Icon />
          </Button>
          <Button
            disabled={!!busy}
            onClick={() => void refresh()}
            variant="outline"
          >
            <RefreshCwIcon
              className={busy === "refresh" ? "animate-spin" : undefined}
              data-icon="inline-start"
            />
            {busy === "refresh" ? "Refreshing…" : "Refresh"}
          </Button>
          <Button disabled={!!busy} onClick={openNew}>
            <PlusIcon data-icon="inline-start" />
            New domain
          </Button>
        </div>
      </header>

      <div className="workspace-summary">
        <span className="stat-item">
          <span className="stat-value">{snapshot?.sites.length ?? 0}</span>
          <span className="stat-label">configurations</span>
        </span>
        <span className="stat-item">
          <span className="status-indicator" data-state="running" />
          <span className="stat-value">
            {snapshot?.sites.filter((site) => site.enabled).length ?? 0}
          </span>
          <span className="stat-label">enabled</span>
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {snapshot
            ? `Updated ${new Date(snapshot.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Not loaded yet"}
        </span>
      </div>

      <div className="nginx-list-toolbar">
        <div className="nginx-search">
          <SearchIcon aria-hidden="true" />
          <Input
            aria-label="Search Nginx domains"
            data-workspace-search
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a domain or configuration…"
            type="search"
            value={query}
          />
        </div>
        <Button
          disabled={!!busy}
          onClick={() =>
            void runOperation(
              "Test Nginx configuration",
              "test_nginx_configuration",
              {},
              false,
              false,
            )
          }
          size="sm"
          variant="ghost"
        >
          <CheckCircle2Icon data-icon="inline-start" />
          Test configuration
        </Button>
        <Button
          disabled={!!busy}
          onClick={() =>
            void runOperation(
              "Test & reload Nginx",
              "reload_nginx_configuration",
            )
          }
          size="sm"
          variant="outline"
        >
          <PlayIcon data-icon="inline-start" />
          Test & reload
        </Button>
      </div>

      {error && !editor && (
        <Alert variant="destructive">
          <AlertTitle>Nginx command failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {snapshot?.warnings.map((warning) => (
        <Alert key={warning}>
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ))}
      {busy && !editor && (
        <p className="nginx-progress" role="status">
          <RefreshCwIcon className="size-3.5 animate-spin" />
          {busy === "refresh"
            ? "Reading server configurations…"
            : busy.startsWith("read-")
              ? "Opening configuration…"
              : `${busy}…`}
        </p>
      )}
      {operation && !editor && <OperationResult operation={operation} />}

      {sites.length ? (
        <div className="native-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domains</TableHead>
                <TableHead>Configuration</TableHead>
                <TableHead>State</TableHead>
                <TableHead>TLS</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map((site) => (
                <TableRow key={site.fileName}>
                  <TableCell>
                    <div className="name-cell">
                      <span className="nginx-domain-icon">
                        <GlobeIcon className="size-4" />
                      </span>
                      <div>
                        <span className="font-medium">
                          {site.domains[0] ?? site.fileName}
                        </span>
                        {site.domains.length > 1 && (
                          <div
                            className="row-subtitle"
                            title={site.domains.slice(1).join(", ")}
                          >
                            {site.domains.slice(1).join(", ")}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="endpoint">{site.fileName}</TableCell>
                  <TableCell>
                    <span className="status-label">
                      <span
                        className="status-indicator"
                        data-state={site.enabled ? "running" : "stopped"}
                      />
                      {site.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {site.hasTls ? (
                      <span className="inline-flex items-center gap-1.5">
                        <LockKeyholeIcon className="size-3" />
                        Configured
                      </span>
                    ) : (
                      "HTTP"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="row-actions">
                      <Button
                        aria-label={`Edit Nginx configuration ${site.fileName}`}
                        disabled={!!busy}
                        onClick={() => void openSite(site, false)}
                        size="sm"
                        variant="ghost"
                      >
                        <PencilIcon data-icon="inline-start" />
                        Edit
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            aria-label={`Actions for Nginx site ${site.fileName}`}
                            disabled={!!busy}
                            size="icon-sm"
                            title="More actions"
                            variant="ghost"
                          >
                            <EllipsisIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => void openSite(site, true)}
                          >
                            <CopyIcon />
                            Duplicate configuration…
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() =>
                              void runOperation(
                                site.enabled
                                  ? "Disable Nginx site"
                                  : "Enable Nginx site",
                                "set_nginx_site_enabled",
                                {
                                  fileName: site.fileName,
                                  enabled: !site.enabled,
                                  expectedRevision: site.revision,
                                },
                              )
                            }
                          >
                            <PlayIcon />
                            {site.enabled ? "Disable site" : "Enable site"}
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
        <Empty className="min-h-60">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GlobeIcon />
            </EmptyMedia>
            <EmptyTitle>
              {search
                ? "No matching domains"
                : snapshot
                  ? "No site configurations found"
                  : "Your domains, without the SSH terminal"}
            </EmptyTitle>
            <EmptyDescription>
              {search
                ? "Try another domain or filename."
                : snapshot
                  ? `No configurations were found in ${settings.configDir}/sites-available.`
                  : "Refresh to load the existing sites, or create a domain with ports, locations, and a certificate."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <p className="nginx-setup-note">
        <span className="endpoint">{settings.configDir}/sites-available</span> ·
        SSH user or passwordless sudo · Python 3, Nginx, and Certbot on the
        server.
      </p>

      <Dialog
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        open={!!editor}
      >
        <DialogContent className="nginx-editor-dialog">
          <DialogHeader>
            <DialogTitle>
              {editor?.kind === "new"
                ? "New domain"
                : editor?.kind === "duplicate"
                  ? "Duplicate configuration"
                  : "Edit Nginx configuration"}
            </DialogTitle>
            <DialogDescription>
              {editor?.kind === "edit"
                ? `${editor.fileName} · ${serverName}`
                : "Review the configuration before saving or enabling HTTPS."}
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <>
              <div className="nginx-editor-body">
                {error && (
                  <Alert variant="destructive">
                    <AlertTitle>Nginx command failed</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                {editorErrors.length > 0 && (
                  <Alert variant="destructive">
                    <AlertTitle>Check the configuration</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-4">
                        {editorErrors.map((message) => (
                          <li key={message}>{message}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {editor.kind === "new" && editor.step === "setup" ? (
                  <>
                    <div className="nginx-form-grid">
                      <NginxField label="Domain" htmlFor="nginx-domain">
                        <Input
                          autoFocus
                          disabled={!!busy}
                          id="nginx-domain"
                          onChange={(event) =>
                            updateDraft({ domain: event.target.value })
                          }
                          placeholder="example.com"
                          value={editor.draft.domain}
                        />
                      </NginxField>
                      <NginxField label="Aliases" htmlFor="nginx-aliases">
                        <Input
                          disabled={!!busy}
                          id="nginx-aliases"
                          onChange={(event) =>
                            updateDraft({ aliases: event.target.value })
                          }
                          placeholder="www.example.com"
                          value={editor.draft.aliases}
                        />
                      </NginxField>
                      <NginxField
                        label="Certificate email"
                        htmlFor="nginx-email"
                      >
                        <Input
                          disabled={!!busy}
                          id="nginx-email"
                          onChange={(event) =>
                            updateDraft({ email: event.target.value })
                          }
                          placeholder="info@example.com"
                          type="email"
                          value={editor.draft.email}
                        />
                      </NginxField>
                      <NginxField
                        label="Configuration filename"
                        htmlFor="nginx-file"
                      >
                        <Input
                          disabled={!!busy}
                          id="nginx-file"
                          onChange={(event) =>
                            updateEditor({ fileName: event.target.value })
                          }
                          placeholder="example.com.conf"
                          value={editor.fileName}
                        />
                      </NginxField>
                    </div>
                    <div className="nginx-location-heading">
                      <div>
                        <h3>Locations</h3>
                        <p>Choose the service for each URL path.</p>
                      </div>
                      <Button
                        disabled={!!busy}
                        onClick={() =>
                          updateDraft({
                            locations: [
                              ...editor.draft.locations,
                              {
                                path: "/api/",
                                upstream: "http://127.0.0.1:3000",
                                stripPrefix: false,
                              },
                            ],
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
                        <PlusIcon data-icon="inline-start" />
                        Add location
                      </Button>
                    </div>
                    <div className="nginx-locations">
                      {editor.draft.locations.map((location, index) => (
                        <div className="nginx-location" key={index}>
                          <NginxField
                            label="Location path"
                            htmlFor={`nginx-location-${index}`}
                          >
                            <Input
                              className="endpoint"
                              disabled={!!busy}
                              id={`nginx-location-${index}`}
                              onChange={(event) =>
                                updateDraft({
                                  locations: editor.draft.locations.map(
                                    (item, itemIndex) =>
                                      itemIndex === index
                                        ? {
                                            ...item,
                                            path: event.target.value,
                                            stripPrefix:
                                              event.target.value === "/"
                                                ? false
                                                : item.stripPrefix,
                                          }
                                        : item,
                                  ),
                                })
                              }
                              placeholder="/b/"
                              value={location.path}
                            />
                          </NginxField>
                          <NginxField
                            label="Proxy destination"
                            htmlFor={`nginx-upstream-${index}`}
                          >
                            <Input
                              className="endpoint"
                              disabled={!!busy}
                              id={`nginx-upstream-${index}`}
                              onChange={(event) =>
                                updateDraft({
                                  locations: editor.draft.locations.map(
                                    (item, itemIndex) =>
                                      itemIndex === index
                                        ? {
                                            ...item,
                                            upstream: event.target.value,
                                          }
                                        : item,
                                  ),
                                })
                              }
                              placeholder="http://127.0.0.1:24002"
                              value={location.upstream}
                            />
                          </NginxField>
                          <label className="nginx-inline-control">
                            <Switch
                              checked={location.stripPrefix}
                              disabled={!!busy || location.path === "/"}
                              onCheckedChange={(checked) =>
                                updateDraft({
                                  locations: editor.draft.locations.map(
                                    (item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, stripPrefix: checked }
                                        : item,
                                  ),
                                })
                              }
                              size="sm"
                            />
                            <span>Strip prefix</span>
                          </label>
                          <Button
                            aria-label={`Remove location ${index + 1}`}
                            disabled={
                              !!busy || editor.draft.locations.length === 1
                            }
                            onClick={() =>
                              updateDraft({
                                locations: editor.draft.locations.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              })
                            }
                            size="icon-sm"
                            title="Remove location"
                            variant="ghost"
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <label className="nginx-inline-control">
                      <Switch
                        checked={editor.draft.useSharedIncludes}
                        disabled={!!busy}
                        onCheckedChange={(checked) =>
                          updateDraft({ useSharedIncludes: checked })
                        }
                        size="sm"
                      />
                      <span>
                        Use existing{" "}
                        <span className="endpoint">nginxconfig.io</span>{" "}
                        security, proxy, and general includes
                      </span>
                    </label>
                    <p className="nginx-help">
                      Strip prefix sends{" "}
                      <span className="endpoint">/b/orders</span> to the service
                      as <span className="endpoint">/orders</span>. Domains must
                      point to this server and allow HTTP traffic on port 80
                      before issuing certificates.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="nginx-form-grid">
                      <NginxField
                        label="Configuration filename"
                        htmlFor="nginx-file"
                      >
                        <Input
                          disabled={!!busy || editor.kind === "edit"}
                          id="nginx-file"
                          onChange={(event) =>
                            updateEditor({ fileName: event.target.value })
                          }
                          value={editor.fileName}
                        />
                      </NginxField>
                      {!existingLiveTls && (
                        <NginxField
                          label="Certificate email"
                          htmlFor="nginx-email"
                        >
                          <Input
                            disabled={!!busy}
                            id="nginx-email"
                            onChange={(event) =>
                              updateDraft({ email: event.target.value })
                            }
                            placeholder="info@example.com"
                            type="email"
                            value={editor.draft.email}
                          />
                        </NginxField>
                      )}
                      {editor.kind !== "new" && !existingLiveTls && (
                        <>
                          <NginxField
                            label={
                              editor.kind === "duplicate"
                                ? "New domain"
                                : "Certificate domain"
                            }
                            htmlFor="nginx-domain"
                          >
                            <Input
                              disabled={!!busy}
                              id="nginx-domain"
                              onChange={(event) =>
                                updateDraft({ domain: event.target.value })
                              }
                              placeholder="new.example.com"
                              value={editor.draft.domain}
                            />
                          </NginxField>
                          <NginxField
                            label="Certificate aliases"
                            htmlFor="nginx-aliases"
                          >
                            <Input
                              disabled={!!busy}
                              id="nginx-aliases"
                              onChange={(event) =>
                                updateDraft({ aliases: event.target.value })
                              }
                              placeholder="www.example.com"
                              value={editor.draft.aliases}
                            />
                          </NginxField>
                        </>
                      )}
                    </div>
                    {editor.kind === "duplicate" && (
                      <div className="nginx-inline-actions">
                        <span className="nginx-help">
                          Copied from {editor.source?.fileName}. Replace the
                          original domain before enabling this site.
                        </span>
                        <Button
                          disabled={!!busy || !editor.draft.domain.trim()}
                          onClick={replaceCopiedDomain}
                          size="sm"
                          variant="outline"
                        >
                          Replace domain in copy
                        </Button>
                      </div>
                    )}
                    {editor.kind === "new" && (
                      <p className="nginx-help">
                        <strong className="text-foreground">
                          {editor.draft.domain}
                        </strong>
                        {editor.draft.aliases &&
                          ` · ${parseDomainAliases(editor.draft.aliases).join(", ")}`}{" "}
                        · Review or edit the generated configuration below.
                      </p>
                    )}
                    <NginxField
                      label="Nginx configuration"
                      htmlFor="nginx-config"
                    >
                      <Suspense
                        fallback={
                          <div
                            className="flex min-h-72 items-center justify-center text-xs text-muted-foreground"
                            role="status"
                          >
                            Loading editor…
                          </div>
                        }
                      >
                        <NginxCodeEditor
                          disabled={!!busy}
                          id="nginx-config"
                          onChange={(content) => updateEditor({ content })}
                          value={editor.content}
                        />
                      </Suspense>
                    </NginxField>
                    <div className="nginx-certificate-options">
                      {editor.kind === "edit" && (
                        <label className="nginx-inline-control">
                          <Switch
                            checked={editor.enabled}
                            disabled={!!busy}
                            onCheckedChange={(checked) =>
                              updateEditor({ enabled: checked })
                            }
                            size="sm"
                          />
                          <span>Site enabled</span>
                        </label>
                      )}
                      {!existingLiveTls && (
                        <label className="nginx-inline-control">
                          <Switch
                            checked={editor.forceRenewal}
                            disabled={!!busy}
                            onCheckedChange={(checked) =>
                              updateEditor({ forceRenewal: checked })
                            }
                            size="sm"
                          />
                          <span>Force certificate renewal</span>
                        </label>
                      )}
                    </div>
                    {existingLiveTls ? (
                      <p className="nginx-help">
                        Save & apply checks the configuration and reloads Nginx
                        using the existing certificate. Certificate setup is
                        available for new or disabled HTTPS sites.
                      </p>
                    ) : (
                      <p className="nginx-help">
                        HTTPS setup enables an HTTP challenge site, runs
                        Certbot, then checks and applies the final
                        configuration. Issuing a certificate accepts the{" "}
                        <a
                          href="https://letsencrypt.org/repository/"
                          rel="noreferrer"
                          target="_blank"
                          onClick={(event) => {
                            if ("__TAURI_INTERNALS__" in window) {
                              event.preventDefault();
                              void openUrl(
                                "https://letsencrypt.org/repository/",
                              ).catch((caught) =>
                                setError(errorMessage(caught)),
                              );
                            }
                          }}
                        >
                          Let’s Encrypt subscriber agreement
                        </a>
                        . Existing certificates are reused when possible. All
                        certificate names must point to this server and accept
                        HTTP traffic on port 80.
                      </p>
                    )}
                  </>
                )}

                {busy && (
                  <div className="nginx-operation-pending" role="status">
                    <RefreshCwIcon className="size-4 animate-spin" />
                    <div>
                      <strong>
                        {provisioning ? "Setting up HTTPS…" : `${busy}…`}
                      </strong>
                      <p>
                        {provisioning
                          ? "HTTP challenge → certificate → configuration test → Nginx reload. This can take several minutes."
                          : "Keep this window open until the server finishes."}
                      </p>
                    </div>
                  </div>
                )}
                {operation && <OperationResult operation={operation} />}
              </div>
              <DialogFooter className="nginx-editor-footer">
                {editor.kind === "new" && editor.step === "configuration" && (
                  <Button
                    className="mr-auto"
                    disabled={!!busy}
                    onClick={() => updateEditor({ step: "setup" })}
                    variant="ghost"
                  >
                    Back to setup
                  </Button>
                )}
                <Button
                  disabled={!!busy}
                  onClick={closeEditor}
                  variant="outline"
                >
                  Cancel
                </Button>
                {editor.kind === "new" && editor.step === "setup" ? (
                  <Button disabled={!!busy} onClick={previewConfiguration}>
                    <FileCode2Icon data-icon="inline-start" />
                    {editor.content &&
                    editor.previewKey !==
                      configurationKey(editor.draft, settings)
                      ? "Regenerate configuration"
                      : "Review configuration"}
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={!!busy}
                      onClick={() => void saveEditor(false)}
                      variant={existingLiveTls ? "default" : "outline"}
                    >
                      {editor.kind === "edit"
                        ? editor.enabled
                          ? "Save & apply"
                          : "Save changes"
                        : "Save draft"}
                    </Button>
                    {!existingLiveTls && (
                      <Button
                        disabled={!!busy}
                        onClick={() => void saveEditor(true)}
                      >
                        <ShieldCheckIcon data-icon="inline-start" />
                        {provisioning
                          ? "Setting up HTTPS…"
                          : "Issue certificate & enable HTTPS"}
                      </Button>
                    )}
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!busy) setSettingsOpen(open);
        }}
        open={settingsOpen}
      >
        <DialogContent className="nginx-settings-dialog">
          <DialogHeader>
            <DialogTitle>Nginx settings</DialogTitle>
            <DialogDescription>
              Paths and permissions for {serverName}.
            </DialogDescription>
          </DialogHeader>
          {settingsErrors.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>{settingsErrors.join(" ")}</AlertDescription>
            </Alert>
          )}
          <NginxField
            label="Nginx configuration directory"
            htmlFor="nginx-config-dir"
          >
            <Input
              id="nginx-config-dir"
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  configDir: event.target.value,
                }))
              }
              placeholder="/etc/nginx"
              value={settingsDraft.configDir}
            />
          </NginxField>
          <NginxField label="ACME webroot" htmlFor="nginx-webroot">
            <Input
              id="nginx-webroot"
              onChange={(event) =>
                setSettingsDraft((current) => ({
                  ...current,
                  webroot: event.target.value,
                }))
              }
              placeholder="/var/www/_letsencrypt"
              value={settingsDraft.webroot}
            />
          </NginxField>
          <label className="nginx-inline-control">
            <Switch
              checked={settingsDraft.useSudo}
              onCheckedChange={(checked) =>
                setSettingsDraft((current) => ({
                  ...current,
                  useSudo: checked,
                }))
              }
              size="sm"
            />
            <span>Use passwordless sudo when the SSH user is not root</span>
          </label>
          <p className="nginx-help">
            The server must already have Python 3 and Nginx installed.
            Certificate setup also requires Certbot. No packages are installed
            by this app.
          </p>
          <DialogFooter>
            <Button onClick={() => setSettingsOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button onClick={saveSettings}>Save settings</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setDiscardAction(null);
        }}
        open={!!discardAction}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your configuration has not been saved to the server.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setEditor(discardAction === "new" ? newEditor() : null);
                setEditorErrors([]);
                setError(null);
                setOperation(null);
                setDiscardAction(null);
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function NginxField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="nginx-field">
      <label
        htmlFor={htmlFor}
        onClick={() => document.getElementById(htmlFor)?.focus()}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function OperationResult({ operation }: { operation: OperationLog }) {
  return (
    <div
      className="nginx-operation-result"
      data-success={operation.success}
      role="status"
    >
      <div className="nginx-operation-title">
        {operation.success ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : (
          <FileCode2Icon className="size-3.5" />
        )}
        <strong>
          {operation.title}: {operation.success ? "completed" : "failed"}
        </strong>
      </div>
      {operation.backupPath && (
        <p className="nginx-help">
          Backup: <span className="endpoint">{operation.backupPath}</span>
        </p>
      )}
      <pre className="nginx-operation-log">
        {operation.log ||
          (operation.success
            ? "Command completed successfully."
            : "The operation failed. Review the server configuration before retrying.")}
      </pre>
    </div>
  );
}
