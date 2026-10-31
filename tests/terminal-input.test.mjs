import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import xterm from "@xterm/xterm";

const { outputText } = ts.transpileModule(
  readFileSync(new URL("../src/lib/terminal-input.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } },
);
const { TerminalInputQueue } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("pastes and keystrokes keep exact byte order across slow IPC and split UTF-8", async () => {
  const sent = [];
  const pending = [];
  const failures = [];
  const input = new TerminalInputQueue((chunk) => {
    sent.push(chunk);
    return new Promise((resolve) => pending.push(resolve));
  }, (error) => failures.push(error));
  const paste = new TextEncoder().encode("x".repeat(8191) + "Привет 🌍".repeat(1500));
  input.write(paste);
  input.write(new Uint8Array([13, 3, 0, 255]));
  assert.equal(sent.length, 1, "only one invoke may be in flight");
  while (pending.length) {
    pending.shift()();
    await tick();
  }
  assert.ok(sent.every((chunk) => chunk.length <= 8192));
  assert.deepEqual(new Uint8Array(sent.flat()), new Uint8Array([...paste, 13, 3, 0, 255]));
  assert.deepEqual(failures, []);
});

test("disconnect discards queued input and does not resume after a late invoke", async () => {
  const sent = [];
  let release;
  const input = new TerminalInputQueue((chunk) => {
    sent.push(chunk);
    return new Promise((resolve) => { release = resolve; });
  }, assert.fail);
  input.write(new Uint8Array(20000));
  input.stop();
  release();
  await tick();
  input.write(new Uint8Array([3]));
  assert.equal(sent.length, 1);
});

test("transport failure stops the queue without replaying any accepted input", async () => {
  const sent = [];
  const failures = [];
  const input = new TerminalInputQueue(async (chunk) => {
    sent.push(chunk);
    throw new Error("SSH session closed");
  }, (error) => failures.push(error.message));
  input.write(new Uint8Array(20000));
  await tick();
  input.write(new Uint8Array([13]));
  assert.equal(sent.length, 1);
  assert.deepEqual(failures, ["SSH session closed"]);
});

test("oversized paste is rejected before any of its bytes reach SSH", () => {
  const sent = [];
  const failures = [];
  const input = new TerminalInputQueue(async (chunk) => { sent.push(chunk); }, (error) => failures.push(error.message));
  input.write(new Uint8Array(256 * 1024 + 1));
  assert.deepEqual(sent, []);
  assert.match(failures[0], /256 KiB/);
});

test("input limit includes bytes currently awaiting acceptance", () => {
  const failures = [];
  const input = new TerminalInputQueue(() => new Promise(() => {}), (error) => failures.push(error.message));
  input.write(new Uint8Array(256 * 1024));
  input.write(new Uint8Array([13]));
  assert.equal(failures.length, 1);
});

test("raw output preserves UTF-8 characters split across SSH packets", async () => {
  const term = new xterm.Terminal();
  try {
    const bytes = new TextEncoder().encode("Привет 🌍");
    for (const byte of bytes) term.write(new Uint8Array([byte]));
    await new Promise((resolve) => term.write("", resolve));
    assert.equal(term.buffer.active.getLine(0).translateToString(true), "Привет 🌍");
  } finally {
    term.dispose();
  }
});

test("queued reset separates old buffered output from a reconnected shell", async () => {
  const term = new xterm.Terminal();
  try {
    term.write("old-session");
    term.write("\x1bc");
    await new Promise((resolve) => term.write("new-session", resolve));
    assert.equal(term.buffer.active.getLine(0).translateToString(true), "new-session");
  } finally {
    term.dispose();
  }
});
