import { invoke } from "@tauri-apps/api/core";
import { NetworkIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
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

type OccupiedPort = {
  port: number;
  protocol: string;
  addresses: string[];
  processes: string[];
  containers: string[];
};

type OccupiedPortsSnapshot = {
  serverId: string;
  serverKey: string;
  fetchedAt: string;
  ports: OccupiedPort[];
  warnings: string[];
};

export function OccupiedPortsCard({
  serverId,
  serverKey,
}: {
  serverId?: string;
  serverKey?: string;
}) {
  const [snapshot, setSnapshot] = useState<OccupiedPortsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState("all");
  const requestId = useRef(0);

  useEffect(
    () => () => {
      requestId.current += 1;
    },
    [],
  );

  async function refresh() {
    if (!serverId || loading) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);

    try {
      const result = await invoke<OccupiedPortsSnapshot>(
        "refresh_occupied_ports",
        {
          serverId,
        },
      );
      if (currentRequest !== requestId.current) return;
      if (result.serverId !== serverId || result.serverKey !== serverKey) {
        throw new Error("Server settings changed. Scan ports again.");
      }
      setSnapshot(result);
    } catch (caught) {
      if (currentRequest !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }

  const search = query.trim().toLowerCase();
  const numericSearch = /^\d+$/.test(search);
  const invalidPort =
    numericSearch && (Number(search) < 1 || Number(search) > 65535);
  const ports =
    snapshot?.ports.filter((entry) => {
      if (protocol !== "all" && entry.protocol !== protocol) return false;
      if (numericSearch) return entry.port === Number(search);
      return [
        `${entry.port}/${entry.protocol}`,
        ...entry.addresses,
        ...entry.processes,
        ...entry.containers,
      ].some((value) => value.toLowerCase().includes(search));
    }) ?? [];
  const tcpCount =
    snapshot?.ports.filter((entry) => entry.protocol === "tcp").length ?? 0;
  const udpCount =
    snapshot?.ports.filter((entry) => entry.protocol === "udp").length ?? 0;

  return (
    <section aria-label="Occupied ports" className="workspace-section">
      <header className="section-heading">
        <div className="min-w-0">
          <p className="workspace-eyebrow">Server port inventory</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">Ports</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            TCP listeners, UDP bindings, and published container ports.
          </p>
        </div>
        <Button
          className="shrink-0"
          disabled={!serverId || loading}
          onClick={() => void refresh()}
          size="sm"
          variant="outline"
        >
          <RefreshCwIcon
            className={loading ? "animate-spin" : undefined}
            data-icon="inline-start"
          />
          {loading ? "Scanning…" : snapshot ? "Refresh" : "Scan ports"}
        </Button>
      </header>
      <div aria-busy={loading} className="flex min-h-0 flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Port scan failed</AlertTitle>
            <AlertDescription>
              {error}
              {snapshot && (
                <p>Results below are from the previous successful scan.</p>
              )}
            </AlertDescription>
          </Alert>
        )}
        {snapshot?.warnings.map((warning) => (
          <Alert key={warning}>
            <AlertTitle>Scan coverage</AlertTitle>
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        ))}
        {snapshot && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <p className="flex items-center gap-3 tabular-nums">
                <span className="font-medium text-foreground">
                  {snapshot.ports.length} occupied
                </span>
                <span>{tcpCount} TCP</span>
                <span>{udpCount} UDP</span>
              </p>
              <p
                title={`Last successful scan: ${new Date(snapshot.fetchedAt).toLocaleString()}`}
              >
                Scanned{" "}
                {new Intl.DateTimeFormat(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(snapshot.fetchedAt))}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1 sm:max-w-sm">
                <SearchIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Search occupied ports"
                  className="pl-8"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a port, process, or container"
                  type="search"
                  value={query}
                />
              </div>
              <Select onValueChange={setProtocol} value={protocol}>
                <SelectTrigger
                  aria-label="Port protocol"
                  className="w-28"
                  size="sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">TCP + UDP</SelectItem>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="udp">UDP</SelectItem>
                </SelectContent>
              </Select>
              <span
                aria-live="polite"
                className="ml-auto text-xs text-muted-foreground tabular-nums"
              >
                {ports.length === snapshot.ports.length
                  ? `${ports.length} bindings`
                  : `${ports.length} of ${snapshot.ports.length}`}
              </span>
            </div>
            {ports.length ? (
              <div className="native-table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Port</TableHead>
                      <TableHead>Protocol</TableHead>
                      <TableHead>Bind address</TableHead>
                      <TableHead>Process</TableHead>
                      <TableHead>Container</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ports.map((entry) => (
                      <TableRow key={`${entry.port}-${entry.protocol}`}>
                        <TableCell className="endpoint align-top font-medium">
                          {entry.port}
                        </TableCell>
                        <TableCell className="align-top text-[11px] font-medium text-muted-foreground">
                          {entry.protocol.toUpperCase()}
                        </TableCell>
                        <TableCell className="endpoint align-top">
                          <PortDetails values={entry.addresses} />
                        </TableCell>
                        <TableCell className="align-top">
                          <PortDetails
                            values={entry.processes}
                            empty="Unavailable"
                          />
                        </TableCell>
                        <TableCell className="align-top">
                          <PortDetails values={entry.containers} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <Empty className="min-h-52">
                <EmptyHeader>
                  <EmptyTitle>
                    {invalidPort
                      ? "Invalid port number"
                      : numericSearch
                        ? `No binding found for port ${Number(search)}${protocol === "all" ? "" : `/${protocol}`}`
                        : search || protocol !== "all"
                          ? "No matching ports"
                          : snapshot.warnings.length
                            ? "No ports found in available data"
                            : "No occupied ports found"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {invalidPort
                      ? "Enter a port between 1 and 65535."
                      : "These results reflect the last scan and its coverage. Refresh before deploying a service."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              IPv4 and IPv6 share one row. Process details depend on SSH
              permissions. Refresh before deploying; ports can change after a
              scan.
            </p>
          </>
        )}
        {!snapshot && !loading && (
          <Empty className="min-h-72">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <NetworkIcon />
              </EmptyMedia>
              <EmptyTitle>
                {serverId ? "See what’s already running" : "Select a server"}
              </EmptyTitle>
              <EmptyDescription>
                {serverId
                  ? "Scan this server to find the ports used by its services and containers."
                  : "Select or add an SSH server to scan its occupied ports."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {!snapshot && loading && (
          <div
            className="flex min-h-72 items-center justify-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className="size-3.5 animate-spin"
            />
            Reading server ports…
          </div>
        )}
      </div>
    </section>
  );
}

function PortDetails({
  values,
  empty = "—",
}: {
  values: string[];
  empty?: string;
}) {
  return values.length ? (
    <div className="flex flex-col gap-0.5">
      {values.map((value) => (
        <span className="break-all whitespace-normal" key={value}>
          {value}
        </span>
      ))}
    </div>
  ) : (
    <span className="text-muted-foreground">{empty}</span>
  );
}
