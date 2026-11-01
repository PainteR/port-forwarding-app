import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const { outputText } = ts.transpileModule(
  readFileSync(new URL("../src/lib/sftp.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } },
);
const { parentPath, joinPath, validFileName, parsePermissions, formatPermissions, formatBytes, transferPercent, visibleEntries } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("folder actions cannot turn a name into another path", () => {
  for (const name of ["", ".", "..", "../escape", "a/b", "a\\b", "bad\0name"]) assert.equal(validFileName(name), false, name);
  for (const name of ["файлы проекта", "a'b", "-folder", ".env", " file "]) assert.equal(validFileName(name), true, name);
  assert.equal(joinPath("/", "file"), "/file");
  assert.equal(joinPath("/home/painter/", "file"), "/home/painter/file");
  assert.equal(parentPath("/"), "/");
  assert.equal(parentPath("/home/"), "/");
  assert.equal(parentPath("/home/painter/"), "/home");
});

test("permissions accept octal modes and omit file type bits", () => {
  assert.equal(parsePermissions("0755"), 0o755);
  assert.equal(parsePermissions("644"), 0o644);
  for (const mode of ["4755", "888", "77777", "-755", "0x755", " 755", "75"]) assert.equal(parsePermissions(mode), null);
  assert.equal(formatPermissions(0o100644), "644");
  assert.equal(formatPermissions(0o40755), "755");
  assert.equal(formatPermissions(null), "—");
});

test("Windows local navigation preserves drive, UNC, and long-path roots", () => {
  const roots = ["C:\\", "C:/", "\\\\server\\share\\", "\\\\?\\C:\\", "\\\\?\\UNC\\server\\share\\"];
  for (const root of roots) {
    const separator = root.includes("\\") ? "\\" : "/";
    assert.equal(parentPath(root), root, root);
    assert.equal(joinPath(root, "folder"), `${root}folder`, root);
    assert.equal(parentPath(`${root}folder${separator}nested${separator}`), `${root}folder`, root);
    assert.equal(parentPath(`${root}folder`), root, root);
  }
  assert.equal(joinPath("C:\\Users\\painter", "файлы"), "C:\\Users\\painter\\файлы");
  assert.equal(parentPath("/home/painter"), "/home");
});

test("archive progress remains indeterminate until a total is known", () => {
  assert.equal(transferPercent(120, null), null);
  assert.equal(transferPercent(0, 0), null);
  assert.equal(transferPercent(150, 100), 100);
  assert.equal(transferPercent(25, 100), 25);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024 ** 2 * 1.5), "1.5 MiB");
  assert.equal(formatBytes(NaN), "—");
});

test("file filtering hides dotfiles, keeps folders first, and preserves original listing", () => {
  const entries = [
    { name: "file10", kind: "file" }, { name: ".env", kind: "file" },
    { name: "file2", kind: "file" }, { name: "z-dir", kind: "directory" },
    { name: "ПРОЕКТ", kind: "directory" },
  ];
  assert.deepEqual(visibleEntries(entries, "", false).map((entry) => entry.name), ["z-dir", "ПРОЕКТ", "file2", "file10"]);
  assert.equal(entries[0].name, "file10");
  assert.deepEqual(visibleEntries(entries, " проект ", true).map((entry) => entry.name), ["ПРОЕКТ"]);
  assert.deepEqual(visibleEntries(entries, ".env", true).map((entry) => entry.name), [".env"]);
  assert.deepEqual(visibleEntries(entries, ".env", false), []);
});
