import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { checkMap, codeCanvasGraph, ensureMap, exportMap, overviewGraph, replaceViewerExact, trailBin } from "./trail-code.mjs";

const roots = [];

function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `trail-export-${name}-`));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "index.js"), "export const visible = true;\n");
  writeFileSync(join(root, "tokens.json"), "{}\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Trail Test", "-c", "user.email=trail@example.test", "commit", "-qm", "fixture"], { cwd: root });
  return root;
}

function commit(root) {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Trail Test", "-c", "user.email=trail@example.test", "commit", "-qm", "fixture update"], { cwd: root });
}

function theme() {
  return {
    name: "Synthetic map",
    source: "tokens.json",
    colors: {
      background: "#f8f7f4", foreground: "#0f172a", accent: "#1b4332", muted: "#5b6577",
      border: "#d8dfdc", panel: "#ffffff", panel2: "#f3f1ec", canvas: "#f8f7f4",
    },
    radius: 8,
  };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const viewerDir = join(dirname(trailBin()), "..", "viewer");
const exporter = join(dirname(trailBin()), "..", "viz", "export.js");

test("exporta HTML offline com abas estruturais, tema e proveniência", { skip: !existsSync(exporter), timeout: 120_000 }, async () => {
  const root = fixture("offline");
  mkdirSync(join(root, "fonts"));
  writeFileSync(join(root, "fonts", "inter.ttf"), Buffer.from([0, 1, 0, 0]));
  commit(root);
  assert.equal(ensureMap(root).fresh, true);
  const result = await exportMap(root, join(root, "map.html"), { ...theme(), fonts: { sans: "fonts/inter.ttf" } });
  const html = readFileSync(join(root, "map.html"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(checkMap(root).fresh, true);
  assert.match(html, /<style>/);
  assert.match(html, /<script nonce="[^"]+" type="module">/);
  assert.doesNotMatch(html, /href="\/style\.css"|src="\/app\.js"/);
  assert.match(html, /Synthetic map/);
  assert.match(html, /tokens\.json/);
  assert.match(html, /SHA [0-9a-f]{40}/);
  assert.doesNotMatch(html, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "i"));
  assert.match(html, /data-tab="code"/);
  assert.match(html, /data-tab="outline"/);
  assert.match(html, /codeCanvasGraph/);
  assert.match(html, /Código por arquivo/);
  assert.match(html, /openCodeFile/);
  assert.match(html, /e\.disabled=!E\.codeDrill/);
  assert.match(html, /E\.code\?\.nodes\.find/);
  assert.match(html, /w\.sim\?\.stop\(\)/);
  assert.equal((html.match(/Math\.max\(\.03,Math\.min\(3,/g) || []).length, 2);
  assert.doesNotMatch(html, /Math\.max\(\.35,Math\.min\(3,/);
  assert.match(html, /data-tab="context"/);
  assert.match(html, /Visão geral/);
  assert.match(html, /Código/);
  assert.match(html, /Arquivos/);
  assert.match(html, /#themeBtn\{display:none!important\}/);
  assert.match(html, /script-src 'nonce-[^']+';[^>]+connect-src 'none'/);
  assert.doesNotMatch(html, /script-src 'unsafe-inline'/);
  assert.equal([...html.matchAll(/<script(?:\s[^>]*)?>/g)].every(([tag]) => /nonce="[^"]+"/.test(tag)), true);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /data:font\/ttf;base64/);
  assert.match(html, /data-trail-project/);
  assert.match(html, /querySelector\("\[data-trail-project\]"\).*textContent/);
  assert.match(html, /\.appbar\{height:auto;min-width:0;flex-wrap:wrap/);
  assert.match(html, /\.searchbox input\{box-sizing:border-box;width:100%;min-width:0\}/);
  const dataScript = html.match(/<script nonce="[^"]+">(window\.__GRAFT_DATA__[\s\S]*?)<\/script>/)?.[1];
  assert.ok(dataScript);
  const sandbox = {};
  sandbox.window = sandbox;
  vm.runInNewContext(dataScript, sandbox);
  assert.ok(sandbox.window.__GRAFT_DATA__.codeGraph.nodes.length >= sandbox.window.__GRAFT_DATA__.codeCanvasGraph.nodes.length);
  const viewerScript = readFileSync(join(viewerDir, "app.js"), "utf8");
  assert.match(viewerScript, /select\(t\)\{this\.selected=t,this\.restyle\(\),this\.onSelect\(t\)\}/);
  const openCodeFile = html.match(/function openCodeFile\(e\)\{[\s\S]*?\}w\.onSelect/)?.[0]?.replace(/w\.onSelect$/, "");
  assert.ok(openCodeFile);
  const drillSandbox = {
    E: { code: {
      nodes: [{ id: "file:a", path: "a.ts" }, { id: "a", path: "a.ts" }, { id: "b", path: "b.ts" }, { id: "c", path: "c.ts" }],
      edges: [{ source: "a", target: "b" }, { source: "b", target: "c" }],
    } },
    J: () => drillSandbox.E.codeDrill, Me() {}, ae() {}, Ne() {}, Dt() {}, codeMode() {},
    w: {
      sim: { stop() { drillSandbox.stopped = true; } }, resetView() {}, setData() {}, reheat() {},
      onSelect() { if (!drillSandbox.E.codeDrill) throw new Error("drill não instalado antes de select"); drillSandbox.selectedCallbacks = (drillSandbox.selectedCallbacks || 0) + 1; },
      select(id) { this.onSelect(id); },
    },
  };
  vm.runInNewContext(openCodeFile, drillSandbox);
  drillSandbox.openCodeFile("file:a");
  assert.equal(drillSandbox.stopped, true);
  assert.equal(drillSandbox.selectedCallbacks, 1);
  assert.deepEqual(drillSandbox.E.codeDrill.nodes.map((node) => node.id), ["file:a", "a", "b"]);
  const keydown = html.match(/ke\.addEventListener\("keydown",[\s\S]*?\}\);_\("zin"\)/)?.[0]?.replace(/;_\("zin"\)$/, ";");
  assert.ok(keydown);
  const searchSandbox = {
    E: { tab: "code", codeDrill: {}, code: { nodes: [{ id: "remote", name: "distantSymbol" }] } },
    w: { query: "distant", firstMatch() { throw new Error("Código deve consultar o grafo integral"); }, focus() {} },
    openCodeFile(id) { searchSandbox.opened = id; },
    ke: { addEventListener(_event, listener) { searchSandbox.keydown = listener; } },
  };
  vm.runInNewContext(keydown, searchSandbox);
  searchSandbox.keydown({ key: "Enter" });
  assert.equal(searchSandbox.opened, "remote");
  const tabChange = html.match(/function dt\(e\)\{[\s\S]*?\}function Ht/)?.[0]?.replace(/function Ht$/, "");
  assert.ok(tabChange);
  const elements = new Map([["canvasWrap", {}], ["outlineView", {}], ["graphEmpty", {}], ["edgeChips", {}], ["legend", {}], ["lcount", {}], ["counts", {}]]);
  const tabSandbox = {
    E: { code: null, outlineOpen: {} },
    document: { querySelectorAll() { return []; } },
    _: (id) => elements.get(id), P() {}, Me() {}, ae() {}, Ne() {}, Dt() {}, codeMode() {}, lt() {},
    w: { sim: { stop() { tabSandbox.stopped = true; } }, hiddenRels: {}, hiddenTypes: {}, selected: null, resetView() { throw new Error("não deve renderizar canvas oculto"); }, setData() { throw new Error("não deve criar simulação em Arquivos"); }, reheat() { throw new Error("não deve reaquecer simulação em Arquivos"); } },
  };
  vm.runInNewContext(tabChange, tabSandbox);
  tabSandbox.dt("outline");
  assert.equal(tabSandbox.stopped, true);

  const hostile = { ...theme(), name: "$&</title><script>alert(1)</script>" };
  await exportMap(root, join(root, "map.html"), hostile);
  const escaped = readFileSync(join(root, "map.html"), "utf8");
  assert.match(escaped, /<title>\$&amp;&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; \| Trail Code<\/title>/);
  assert.doesNotMatch(escaped, /<script>alert\(1\)<\/script>/);
});

test("agrega o overview por dois segmentos e compacta relações cruzadas", () => {
  const overview = overviewGraph({
    meta: { version: 1 },
    nodes: [
      { id: "a", path: "src/app/page.tsx", kind: "file" },
      { id: "b", path: "src/app/page.tsx", kind: "function" },
      { id: "c", path: "src/lib/auth.ts", kind: "file" },
      { id: "d", path: "README.md", kind: "file" },
    ],
    edges: [{ source: "b", target: "c" }, { source: "a", target: "c" }, { source: "c", target: "d" }],
  });
  assert.deepEqual(overview.nodes.map((node) => [node.name, node.summary]), [["root", "1 arquivo; 0 símbolos"], ["src/app", "1 arquivo; 1 símbolo"], ["src/lib", "1 arquivo; 0 símbolos"]]);
  assert.deepEqual(overview.edges.map((edge) => [edge.source, edge.target, edge.description]), [["module:src/app", "module:src/lib", "2 relações entre módulos"], ["module:src/lib", "module:root", "1 relação entre módulos"]]);
});

test("compacta Código por arquivo sem perder o grafo integral para Arquivos", () => {
  const wiring = {
    meta: { version: 1 },
    nodes: [
      { id: "file:a", path: "src/a.ts", kind: "file", name: "a.ts" },
      { id: "a:one", path: "src/a.ts", kind: "function", name: "one" },
      { id: "a:two", path: "src/a.ts", kind: "function", name: "two" },
      { id: "file:b", path: "src/b.ts", kind: "file", name: "b.ts" },
      { id: "b:one", path: "src/b.ts", kind: "function", name: "one" },
      { id: "outside", path: "src/missing.ts", kind: "function", name: "missing" },
    ],
    edges: [
      { source: "a:one", target: "b:one", relation: "uses" },
      { source: "a:two", target: "b:one", relation: "uses" },
      { source: "a:one", target: "a:two", relation: "calls" },
      { source: "a:one", target: "outside", relation: "uses" },
    ],
  };
  const compact = codeCanvasGraph(wiring);

  assert.deepEqual(compact.nodes.map(({ id, name, kind, summary }) => ({ id, name, kind, summary })), [
    { id: "file:a", name: "a.ts", kind: "file", summary: "2 símbolos em src/a.ts" },
    { id: "file:b", name: "b.ts", kind: "file", summary: "1 símbolo em src/b.ts" },
  ]);
  assert.deepEqual(compact.edges, [{ source: "file:a", target: "file:b", relation: "uses", description: "2 relações entre arquivos" }]);
  assert.equal(codeCanvasGraph({ ...wiring, edges: [wiring.edges[0]] }).edges[0].description, "1 relação entre arquivos");
  assert.equal(wiring.nodes.length, 6);
  assert.equal(wiring.edges.length, 4);
  assert.deepEqual(codeCanvasGraph({ meta: { version: 1 }, nodes: [], edges: [] }), { meta: { nodeCount: 0, edgeCount: 0 }, nodes: [], edges: [] });
});

test("falha fechado quando uma âncora do viewer está ausente ou duplicada", () => {
  assert.equal(replaceViewerExact("zoom old zoom old", "old", "new", 2, "zoom"), "zoom new zoom new");
  assert.throws(() => replaceViewerExact("zoom new zoom new", "old", "new", 2, "zoom"), /âncora zoom/i);
  assert.throws(() => replaceViewerExact("old old old", "old", "new", 2, "zoom"), /âncora zoom/i);
});

test("aceita saída externa explícita e rejeita tema injetável ou fonte em link", async () => {
  const root = fixture("safety");
  const outside = mkdtempSync(join(tmpdir(), "trail-export-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "font.woff2"), "synthetic");
  mkdirSync(join(root, "fonts"));
  writeFileSync(join(root, "fonts", "fake.woff2"), "synthetic");
  symlinkSync(join(outside, "font.woff2"), join(root, "fonts", "font.woff2"), "file");
  commit(root);
  assert.equal(ensureMap(root).fresh, true);

  assert.equal((await exportMap(root, join(outside, "map.html"), theme())).ok, true);
  assert.equal(existsSync(join(outside, "map.html")), true);
  await assert.rejects(exportMap(root, join(root, "map.html"), { ...theme(), colors: { ...theme().colors, accent: "#fff;body{}" } }), /cor inválida/i);
  await assert.rejects(exportMap(root, join(root, "map.html"), { ...theme(), fonts: { sans: "fonts/font.woff2" } }), /link/i);
  await assert.rejects(exportMap(root, join(root, "map.html"), { ...theme(), fonts: { sans: "fonts/fake.woff2" } }), /fonte inválida/i);
  await assert.rejects(exportMap(root, join(root, "map.html"), { ...theme(), source: "missing.json" }), /origem do tema ausente/i);
});

test("recusa mapa desatualizado e arquivo existente que não foi gerado", async () => {
  const root = fixture("freshness");
  assert.equal(ensureMap(root).fresh, true);
  writeFileSync(join(root, "index.js"), "export const changed = true;\n");
  await assert.rejects(exportMap(root, join(root, "map.html"), theme()), /desatualizado/i);
  assert.equal(ensureMap(root).fresh, true);
  writeFileSync(join(root, "map.html"), "do not overwrite\n");
  await assert.rejects(exportMap(root, join(root, "map.html"), theme()), /recusa sobrescrever/i);
});

test("recusa árvore dirty mesmo quando o mapa estrutural segue fresco", async () => {
  const root = fixture("dirty");
  assert.equal(ensureMap(root).fresh, true);
  writeFileSync(join(root, "tokens.json"), "{\"dirty\":true}\n");
  assert.equal(ensureMap(root).fresh, true);
  await assert.rejects(exportMap(root, join(root, "map.html"), theme(), "HEAD"), /repositório fonte limpo/i);
});

test("executa check e export pela junction da skill compartilhada", { skip: !existsSync(exporter), timeout: 120_000 }, () => {
  const root = fixture("junction");
  writeFileSync(join(root, "tokens.json"), `${JSON.stringify(theme(), null, 2)}\n`);
  commit(root);
  assert.equal(ensureMap(root).fresh, true);

  const linkRoot = mkdtempSync(join(tmpdir(), "trail-junction-"));
  roots.push(linkRoot);
  const sourceDir = dirname(fileURLToPath(new URL("./trail-code.mjs", import.meta.url)));
  const linkedDir = join(linkRoot, "trail-code");
  symlinkSync(sourceDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
  const wrapper = join(linkedDir, "trail-code.mjs");

  const checked = execFileSync(process.execPath, [wrapper, "check", "--repo", root], { encoding: "utf8", windowsHide: true });
  assert.match(checked, /\[trail-code\] fresco/);

  const output = join(root, "map.html");
  writeFileSync(output, '<div data-trail-code-export="v1">anterior</div>\n');
  const exported = execFileSync(process.execPath, [wrapper, "export", "--repo", root, "--out", output, "--theme", join(root, "tokens.json"), "--ref", "HEAD"], { encoding: "utf8", windowsHide: true });
  assert.match(exported, /\[trail-code\] exportado/);
  assert.match(readFileSync(output, "utf8"), /<title>Synthetic map \| Trail Code<\/title>/);
  assert.doesNotMatch(readFileSync(output, "utf8"), /anterior/);
});
