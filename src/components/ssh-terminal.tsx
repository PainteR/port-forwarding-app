import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { EraserIcon, PlayIcon, RefreshCwIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TerminalInputQueue } from "@/lib/terminal-input";

import "@xterm/xterm/css/xterm.css";
import "./ssh-terminal.css";

type TerminalEvent =
  | { type: "ready" }
  | { type: "data"; data: number[] }
  | { type: "closed"; exitCode: number | null; message: string | null };

type ConnectionState = "idle" | "connecting" | "connected" | "closed";
type ActiveSession = {
  id: string;
  ready: boolean;
  input: TerminalInputQueue;
  opened: Promise<void>;
  ackBytes: number;
  ackTimer?: number;
};

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function terminalTheme() {
  const dark = document.documentElement.classList.contains("dark");
  return dark
    ? { background: "#15171b", foreground: "#e2e5ea", cursor: "#cbd5e1", selectionBackground: "#3b4c64" }
    : { background: "#fbfbfc", foreground: "#242832", cursor: "#242832", selectionBackground: "#cddcf2" };
}

export function SshTerminal({
  serverId,
  endpoint,
  active,
}: {
  serverId: string;
  endpoint: string;
  active: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const session = useRef<ActiveSession | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  function closeSession(current: ActiveSession) {
    current.ready = false;
    current.input.stop();
    window.clearTimeout(current.ackTimer);
    // Wait until registration completes so disconnect during connect cannot leak a shell.
    void current.opened.then(() => invoke("terminal_close", { sessionId: current.id })).catch(() => {});
  }

  function failSession(current: ActiveSession, caught: unknown) {
    if (session.current !== current) return;
    session.current = null;
    closeSession(current);
    if (terminal.current) terminal.current.options.disableStdin = true;
    setError(messageOf(caught));
    setState("closed");
  }

  function fitTerminal() {
    if (!host.current?.clientWidth || !host.current.clientHeight) return;
    fit.current?.fit();
  }

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      screenReaderMode: true,
      theme: terminalTheme(),
      allowProposedApi: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host.current);
    terminal.current = term;
    fit.current = fitAddon;
    const encoder = new TextEncoder();
    const data = term.onData((text) => {
      if (session.current?.ready) session.current.input.write(encoder.encode(text));
    });
    const binary = term.onBinary((text) => {
      if (session.current?.ready) {
        session.current.input.write(Uint8Array.from(text, (char) => char.charCodeAt(0)));
      }
    });
    let resizeTimer: number | undefined;
    const resize = term.onResize(({ cols, rows }) => {
      const current = session.current;
      if (!current?.ready) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (session.current !== current) return;
        void invoke("terminal_resize", { sessionId: current.id, cols, rows })
          .catch((caught) => failSession(current, caught));
      }, 50);
    });
    // Cmd shortcuts use WebView clipboard events. Other platforms use terminal shortcuts.
    term.attachCustomKeyEventHandler((event) => {
      if (event.metaKey && (event.code === "KeyC" || event.code === "KeyV")) return false;
      if (event.ctrlKey && event.shiftKey && (event.code === "KeyC" || event.code === "KeyV")) {
        if (event.type === "keydown") {
          event.preventDefault();
          const current = session.current;
          const action = event.code === "KeyC"
            ? navigator.clipboard.writeText(term.getSelection())
            : navigator.clipboard.readText().then((text) => {
              if (current?.ready && session.current === current) term.paste(text);
            });
          void action.catch((caught) => setError(`Clipboard: ${messageOf(caught)}`));
        }
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(host.current);
    const appearance = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const frame = requestAnimationFrame(fitTerminal);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      appearance.disconnect();
      if (session.current) closeSession(session.current);
      session.current = null;
      data.dispose();
      binary.dispose();
      resize.dispose();
      term.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      fitTerminal();
      if (session.current?.ready) terminal.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  function acknowledge(current: ActiveSession, bytes: number) {
    if (session.current !== current) return;
    current.ackBytes += bytes;
    if (current.ackTimer !== undefined) return;
    current.ackTimer = window.setTimeout(() => {
      current.ackTimer = undefined;
      const bytes = current.ackBytes;
      current.ackBytes = 0;
      if (session.current !== current || !bytes) return;
      void invoke("terminal_ack", { sessionId: current.id, bytes })
        .catch((caught) => failSession(current, caught));
    }, 16);
  }

  function connect() {
    const term = terminal.current;
    if (!term || session.current) return;
    setError(null);
    setExitCode(null);
    if (!isTauri()) {
      setError("Open the desktop app to use SSH. The browser preview cannot connect to servers.");
      return;
    }
    fitTerminal();
    // Queue the reset after old output, which xterm's synchronous reset() leaves pending.
    term.write("\x1bc");
    term.options.disableStdin = true;
    const id = crypto.randomUUID();
    const current: ActiveSession = {
      id,
      ready: false,
      opened: Promise.resolve(),
      ackBytes: 0,
      input: new TerminalInputQueue(
        (data) => invoke("terminal_write", { sessionId: id, data }),
        (caught) => failSession(current, caught),
      ),
    };
    session.current = current;
    setState("connecting");
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = (event) => {
      if (session.current !== current) return;
      if (event.type === "ready") {
        current.ready = true;
        term.options.disableStdin = false;
        setState("connected");
        // The workspace may have resized while authentication was in progress.
        fitTerminal();
        void invoke("terminal_resize", { sessionId: id, cols: term.cols, rows: term.rows })
          .catch((caught) => failSession(current, caught));
        if (host.current?.clientWidth) term.focus();
      } else if (event.type === "data") {
        // xterm keeps a streaming UTF-8 decoder across binary writes.
        term.write(new Uint8Array(event.data), () => acknowledge(current, event.data.length));
      } else {
        session.current = null;
        current.ready = false;
        current.input.stop();
        window.clearTimeout(current.ackTimer);
        term.options.disableStdin = true;
        setExitCode(event.exitCode);
        setError(event.message);
        setState("closed");
      }
    };
    current.opened = invoke<void>("terminal_open", {
      serverId, sessionId: id, cols: term.cols, rows: term.rows, onEvent: channel,
    });
    void current.opened.catch((caught) => failSession(current, caught));
  }

  function disconnect() {
    const current = session.current;
    if (!current) return;
    session.current = null;
    closeSession(current);
    if (terminal.current) terminal.current.options.disableStdin = true;
    setState("closed");
  }

  const connected = state === "connected";
  const connecting = state === "connecting";
  const status = connecting ? "Connecting…" : connected ? "Connected" : state === "closed" ? "Disconnected" : "Not connected";

  return (
    <section aria-label="SSH terminal" className="workspace-section ssh-workspace">
      <header className="workspace-heading">
        <div>
          <p className="workspace-eyebrow">Remote shell</p>
          <h1>Terminal</h1>
          <p>Open an interactive SSH shell on this server.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button disabled={state === "idle"} onClick={() => terminal.current?.clear()} size="sm" variant="ghost" title="Clear terminal scrollback">
            <EraserIcon data-icon="inline-start" />Clear
          </Button>
          {connected || connecting ? (
            <Button onClick={disconnect} size="sm" variant="outline">
              <SquareIcon data-icon="inline-start" />{connecting ? "Cancel" : "Disconnect"}
            </Button>
          ) : (
            <Button onClick={connect} size="sm">
              {state === "closed" ? <RefreshCwIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
              {state === "closed" ? "Reconnect" : "Connect"}
            </Button>
          )}
        </div>
      </header>
      <div className="ssh-terminal-frame">
        <div className="ssh-terminal-toolbar">
          <TerminalIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{endpoint}</span>
          <span aria-live="polite" className="ssh-terminal-status" data-connected={connected}>
            <span className={connecting ? "animate-pulse" : undefined} />{status}
            {state === "closed" && exitCode !== null ? ` · exit ${exitCode}` : ""}
          </span>
        </div>
        <div className="ssh-terminal-surface">
          <div aria-label={`SSH terminal for ${endpoint}`} className="ssh-terminal-host" ref={host} />
          {state === "idle" && (
            <div className="ssh-terminal-placeholder">
              <TerminalIcon aria-hidden="true" className="mb-3 size-7 opacity-50" />
              <p className="font-medium text-foreground">Your server, one shell away</p>
              <p className="mt-2">Connect using this server’s saved SSH profile.</p>
            </div>
          )}
        </div>
      </div>
      {error && <p className="ssh-terminal-error" role="alert">{error}</p>}
      <p className="ssh-terminal-help">
        Ctrl+C interrupts · Ctrl+D exits · Copy/paste: ⌘C / ⌘V on macOS, Ctrl+Shift+C / V elsewhere.
        <span> Switching sections keeps the shell open. Switching servers closes it.</span>
      </p>
    </section>
  );
}
