#!/usr/bin/env node
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_VERSION = "0.23.0";
const GIT_TIMEOUT_MS = 10_000;
const CHECK_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 120_000;
const QUERY_COMMANDS = new Set(["ask", "grep", "skeleton", "callers", "map", "blast"]);
const FILE_TOOLS = /^(?:apply_patch|Edit|Write|MultiEdit|NotebookEdit)$/i;
const SHELL_TOOLS = /^(?:Bash|PowerShell|exec_command|shell)$/i;
const OWNER_FILE = ".trail-code-map.json";
const OWNER_RECORD = '{"owner":"trail-code-wrapper","version":1}\n';
const EXPORT_MARKER = 'data-trail-code-export="v1"';
const THEME_COLORS = ["background", "foreground", "accent", "muted", "border", "panel", "panel2", "canvas"];
const THEME_FONTS = ["sans", "mono"];

export function trailBin() {
  if (process.env.TRAIL_CODE_BIN) return process.env.TRAIL_CODE_BIN;
  if (process.platform === "win32") return join(process.env.APPDATA || "", "npm", "node_modules", "@trailhq", "trail-code", "dist", "bin", "trail.js");
  const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false });
  return root.status === 0 && root.stdout.trim() ? join(root.stdout.trim(), "@trailhq", "trail-code", "dist", "bin", "trail.js") : "";
}

function fingerprintModule() {
  return process.env.TRAIL_CODE_FINGERPRINT || resolve(dirname(trailBin()), "..", "graph", "fingerprint.js");
}

function compatibleVersion() {
  if (process.env.TRAIL_CODE_FINGERPRINT) return true;
  try {
    const packageJson = resolve(dirname(trailBin()), "..", "..", "package.json");
    return JSON.parse(readFileSync(packageJson, "utf8")).version === CLI_VERSION;
  } catch {
    return false;
  }
}

function rootResolution(candidate) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) return { root: null, reason: "raiz Git absoluta e segura obrigatória" };
  try {
    const probe = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false });
    if (probe.error?.code === "EPERM") return { root: null, reason: "sandbox não permite subprocesso git; use busca somente leitura como fallback" };
    if (probe.error?.code === "ETIMEDOUT") return { root: null, reason: "timeout ao localizar a raiz Git" };
    if (probe.status !== 0 || !probe.stdout.trim()) return { root: null, reason: "caminho não pertence a um repositório Git acessível" };
    const root = realpathSync(probe.stdout.trim());
    const home = realpathSync(homedir());
    if (root === home || root === parse(root).root) return { root: null, reason: "home e raiz de drive não podem ser indexadas" };
    return { root, reason: "ok" };
  } catch {
    return { root: null, reason: "não foi possível validar a raiz Git" };
  }
}

function safeRoot(candidate) {
  return rootResolution(candidate).root;
}

function nearestExistingDirectory(path) {
  let current = path;
  while (current && current !== parse(current).root) {
    try {
      if (lstatSync(current).isDirectory()) return current;
    } catch { /* deleted or not created yet */ }
    current = dirname(current);
  }
  return path;
}

function patchPaths(raw, base) {
  if (typeof raw !== "string" || !isAbsolute(base)) return [];
  const paths = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const value = match?.[2] || match?.[1];
    if (!value || value === "/dev/null") continue;
    paths.push(isAbsolute(value) ? value : resolve(base, value));
  }
  return paths;
}

export function repositoriesFor(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return [];
  const rawInput = event.tool_input;
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
  const bases = [input.workdir, input.cwd, event.cwd].filter((value) => typeof value === "string" && isAbsolute(value));
  const base = bases[0];
  const targets = [];
  for (const key of ["file_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value) targets.push(isAbsolute(value) ? value : base ? resolve(base, value) : "");
  }
  const patchTool = /^apply_patch$/i.test(String(event.tool_name || ""));
  const patch = patchTool
    ? (typeof rawInput === "string" ? rawInput : input.patch || input.input || input.command || "")
    : "";
  targets.push(...patchPaths(patch, base));

  const roots = new Set();
  for (const target of targets.filter(Boolean)) {
    const root = safeRoot(nearestExistingDirectory(dirname(target)));
    if (root) roots.add(root);
  }
  if (roots.size) return [...roots];
  for (const candidate of bases) {
    const root = safeRoot(candidate);
    if (root) return [root];
  }
  return [];
}

export function repositoryFor(event) {
  return repositoriesFor(event)[0] || null;
}

function cacheSafety(root) {
  const cache = join(root, "graft");
  try {
    if (!existsSync(cache)) return { ok: true, cache };
    const stat = lstatSync(cache);
    if (stat.isSymbolicLink()) return { ok: false, reason: "cache graft/ é link", cache };
    if (!stat.isDirectory()) return { ok: false, reason: "cache graft/ não é diretório", cache };
    if (realpathSync(cache) !== cache) return { ok: false, reason: "cache graft/ sai da worktree", cache };
    for (const target of [join(cache, ".graph"), join(cache, ".cache"), join(cache, ".graph", "wiring.json"), join(cache, ".cache", "ask-index.json"), join(cache, OWNER_FILE)]) {
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) return { ok: false, reason: "mapa Trail-Code contém link", cache };
    }
    const metadata = join(cache, ".cache");
    if (existsSync(metadata)) {
      for (const name of readdirSync(metadata)) {
        if (/^fingerprint\..+\.json$/.test(name) && lstatSync(join(metadata, name)).isSymbolicLink()) return { ok: false, reason: "mapa Trail-Code contém link", cache };
      }
    }
    return { ok: true, cache };
  } catch {
    return { ok: false, reason: "cache graft/ indisponível", cache };
  }
}

function recognizedCache(cache) {
  try {
    if (readFileSync(join(cache, OWNER_FILE), "utf8") === OWNER_RECORD) return true;
  } catch { /* legacy map without wrapper marker */ }
  try {
    return lstatSync(join(cache, ".graph", "wiring.json")).isFile()
      && readdirSync(join(cache, ".cache")).some((name) => /^fingerprint\..+\.json$/.test(name));
  } catch {
    return false;
  }
}

function containsLink(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) return true;
    if (stat.isDirectory() && containsLink(child)) return true;
  }
  return false;
}

function prepareCache(root) {
  const safety = cacheSafety(root);
  if (!safety.ok) return safety;
  if (existsSync(safety.cache)) {
    if (!recognizedCache(safety.cache)) return { ok: false, reason: "graft/ preexistente não é um mapa Trail-Code reconhecido", cache: safety.cache };
    try {
      if (containsLink(safety.cache)) return { ok: false, reason: "mapa Trail-Code contém link", cache: safety.cache };
    } catch {
      return { ok: false, reason: "não foi possível validar os alvos do mapa", cache: safety.cache };
    }
  } else {
    mkdirSync(safety.cache);
  }
  try {
    writeFileSync(join(safety.cache, OWNER_FILE), OWNER_RECORD, { flag: "w" });
    return safety;
  } catch {
    return { ok: false, reason: "não foi possível registrar ownership do mapa", cache: safety.cache };
  }
}

function localExclude(root) {
  const probe = spawnSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false });
  if (probe.status !== 0 || !probe.stdout.trim()) throw new Error("git exclude indisponível");
  const path = isAbsolute(probe.stdout.trim()) ? probe.stdout.trim() : resolve(root, probe.stdout.trim());
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("git exclude é link");
  const commonProbe = spawnSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false });
  if (commonProbe.status !== 0 || !commonProbe.stdout.trim()) throw new Error("git common dir indisponível");
  const common = realpathSync(isAbsolute(commonProbe.stdout.trim()) ? commonProbe.stdout.trim() : resolve(root, commonProbe.stdout.trim()));
  const parent = realpathSync(dirname(path));
  const rel = relative(common, parent);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("git exclude sai do common dir");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!current.split(/\r?\n/).includes("/graft/")) appendFileSync(path, `${current && !current.endsWith("\n") ? "\n" : ""}/graft/\n`);
}

function invoke(args, timeoutMs) {
  const bin = trailBin();
  if (!existsSync(bin) || !compatibleVersion()) return { ok: false, reason: "CLI Trail-Code 0.23.0 indisponível ou incompatível", status: null, stdout: "" };
  const executable = [".js", ".mjs", ".cjs"].includes(extname(bin).toLowerCase()) ? process.execPath : bin;
  const argv = executable === process.execPath ? [bin, ...args] : args;
  const result = spawnSync(executable, argv, {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
    windowsHide: true,
    env: { ...process.env, DO_NOT_TRACK: "1", CI: "1" },
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const reason = result.error?.code === "ETIMEDOUT" ? "timeout" : /\block\b|already syncing|busy/i.test(text) ? "lock" : result.status === 0 ? "ok" : "falha";
  return { ok: result.status === 0, reason, status: result.status, stdout: result.stdout || "" };
}

function mapArgs(root, args) {
  return ["--dir", join(root, "graft"), ...args];
}

export function checkMap(root, hash = false) {
  const safety = cacheSafety(root);
  if (!safety.ok) return { ok: false, fresh: false, reason: safety.reason };
  if (!existsSync(safety.cache)) return { ok: false, fresh: false, reason: "mapa ausente" };
  if (!recognizedCache(safety.cache)) return { ok: false, fresh: false, reason: "graft/ preexistente não é um mapa Trail-Code reconhecido" };
  const module = fingerprintModule();
  if (!compatibleVersion() || !existsSync(module)) return { ok: false, fresh: false, reason: "probe Trail-Code 0.23.0 indisponível ou incompatível" };
  const script = `
import { pathToFileURL } from "node:url";
const api = await import(pathToFileURL(process.argv[1]).href);
if (typeof api.probeDrift !== "function" || typeof api.isClean !== "function") process.exit(3);
const drift = api.probeDrift(process.argv[2], process.argv[3]);
process.stdout.write(JSON.stringify(drift === null ? { ready: false } : { ready: true, clean: api.isClean(drift), count: drift.changed.length + drift.added.length + drift.removed.length }));
`;
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", script, module, root, safety.cache], {
    encoding: "utf8", timeout: CHECK_TIMEOUT_MS, shell: false, windowsHide: true,
    env: { ...process.env, DO_NOT_TRACK: "1", CI: "1", ...(hash ? { GRAFT_REFRESH: "hash" } : {}) },
  });
  if (probe.status !== 0) return { ok: false, fresh: false, reason: probe.error?.code === "ETIMEDOUT" ? "timeout no probe" : "probe incompatível" };
  try {
    const state = JSON.parse(probe.stdout);
    if (!state.ready) return { ok: false, fresh: false, reason: "mapa ausente ou fingerprint inválido" };
    return state.clean
      ? { ok: true, fresh: true, reason: "fresco" }
      : { ok: false, fresh: false, reason: `desatualizado (${state.count} arquivo(s))` };
  } catch {
    return { ok: false, fresh: false, reason: "resposta inválida do probe" };
  }
}

export function ensureMap(root, timeoutMs = Number(process.env.TRAIL_CODE_TIMEOUT_MS) || COMMAND_TIMEOUT_MS) {
  const safety = cacheSafety(root);
  if (!safety.ok) return { ok: false, fresh: false, reason: safety.reason };
  const first = checkMap(root);
  if (first.fresh) {
    try { localExclude(root); } catch (error) { return { ok: false, fresh: false, reason: `não foi possível ignorar o cache local: ${error instanceof Error ? error.message : "erro desconhecido"}` }; }
    return first;
  }
  const prepared = prepareCache(root);
  if (!prepared.ok) return { ok: false, fresh: false, reason: prepared.reason };
  try { localExclude(root); } catch (error) { return { ok: false, fresh: false, reason: `não foi possível ignorar o cache local: ${error instanceof Error ? error.message : "erro desconhecido"}` }; }
  const built = invoke(mapArgs(root, ["build", "--no-gitignore", "--no-ignore", root]), timeoutMs);
  if (!built.ok) return { ok: false, fresh: false, reason: built.reason };
  const final = checkMap(root);
  return final.fresh ? { ok: true, fresh: true, reason: "atualizado e verificado" } : { ok: false, fresh: false, reason: `verificação final: ${final.reason}` };
}

function emptyArrays(value, keys) {
  return keys.every((key) => Array.isArray(value?.[key]) && value[key].length === 0);
}

export function verifyMap(root) {
  const safety = cacheSafety(root);
  if (!safety.ok) return { ok: false, fresh: false, reason: safety.reason };
  if (!existsSync(safety.cache) || !recognizedCache(safety.cache)) return { ok: false, fresh: false, reason: "mapa Trail-Code reconhecido ausente" };
  const result = invoke(mapArgs(root, ["build", "--check", "--json", root]), COMMAND_TIMEOUT_MS);
  try {
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    const graphFresh = report?.graph?.ok === true && report.graph.missing === false
      && emptyArrays(report.graph, ["added", "removed", "changed", "stale"]);
    const expectedMapOnlyContext = report?.context?.ok === false && report.context.missing === true
      && emptyArrays(report.context, ["contentDrift", "removed", "coverage", "indexDrift"]);
    if (graphFresh && expectedMapOnlyContext) return { ok: true, fresh: true, reason: "grafo estrutural verificado" };
    return { ok: false, fresh: false, reason: "verificação estrutural falhou" };
  } catch {
    return { ok: false, fresh: false, reason: result.reason === "timeout" ? "timeout" : "JSON de verificação inválido" };
  }
}

export function queryMap(root, command, args = []) {
  if (!QUERY_COMMANDS.has(command)) return { ok: false, reason: "consulta não permitida", stdout: "" };
  if (args.some((arg) => /^(?:--deep|--dir|--api-key|--provider|--model|--base-url|--name|--export-viz)(?:=|$)/.test(arg))) return { ok: false, reason: "opção não permitida", stdout: "" };
  const checked = checkMap(root);
  if (!checked.fresh) return { ...checked, reason: `${checked.reason}; execute ensure com autorização de escrita`, stdout: "" };
  const result = invoke(mapArgs(root, [command, ...args.filter((arg) => arg !== "--no-refresh"), "--no-refresh", root]), COMMAND_TIMEOUT_MS);
  const stdout = result.stdout.split(/\r?\n/).filter((line) => !/^\[trail\] tokens saved\b/i.test(line)).join("\n").replace(/^\n+|\n+$/g, "");
  const final = result.ok ? checkMap(root) : { fresh: false, reason: result.reason };
  if (!final.fresh) return { ok: false, fresh: false, reason: `consulta não confirmada: ${final.reason}`, stdout: "" };
  return { ok: true, fresh: true, reason: "consulta concluída", stdout: stdout ? `${stdout}\n` : "" };
}

function inside(root, candidate, label) {
  const value = resolve(root, candidate);
  const rel = relative(root, value);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error(`${label} deve ficar dentro do repositório`);
  return value;
}

function assertNoLink(root, target) {
  let current = root;
  for (const part of relative(root, target).split(/[\\/]/)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`${part} é link`);
  }
}

function assertDestinationWithoutLinks(target) {
  let current = parse(target).root;
  for (const part of relative(current, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`${part} é link`);
  }
}

function html(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function validateTheme(theme, root) {
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) throw new Error("tema inválido");
  if (Object.keys(theme).some((key) => !["name", "source", "colors", "radius", "fonts"].includes(key))) throw new Error("tema contém campo não permitido");
  if (typeof theme.name !== "string" || !theme.name.trim() || theme.name.length > 120) throw new Error("nome do tema inválido");
  if (typeof theme.source !== "string" || !theme.source || isAbsolute(theme.source) || theme.source.split(/[\\/]/).includes("..")) throw new Error("origem do tema deve ser caminho relativo");
  const sourceFile = inside(root, theme.source, "origem do tema");
  assertNoLink(root, sourceFile);
  if (!existsSync(sourceFile) || !lstatSync(sourceFile).isFile() || realpathSync(sourceFile) !== sourceFile) throw new Error("origem do tema ausente ou link");
  if (!theme.colors || typeof theme.colors !== "object" || Array.isArray(theme.colors) || Object.keys(theme.colors).length !== THEME_COLORS.length || THEME_COLORS.some((key) => !Object.hasOwn(theme.colors, key) || !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(theme.colors[key]))) throw new Error("cor inválida no tema");
  if (!Number.isFinite(theme.radius) || theme.radius < 0 || theme.radius > 32) throw new Error("raio do tema inválido");
  const fonts = {};
  if (theme.fonts !== undefined) {
    if (!theme.fonts || typeof theme.fonts !== "object" || Array.isArray(theme.fonts) || Object.keys(theme.fonts).some((key) => !THEME_FONTS.includes(key))) throw new Error("fonte inválida no tema");
    for (const key of THEME_FONTS) {
      const source = theme.fonts[key];
      if (source === undefined) continue;
      const extension = typeof source === "string" ? extname(source).toLowerCase() : "";
      if (typeof source !== "string" || ![".woff2", ".ttf"].includes(extension) || isAbsolute(source) || source.split(/[\\/]/).includes("..")) throw new Error("fonte inválida no tema");
      const file = inside(root, source, "fonte");
      assertNoLink(root, file);
      if (!existsSync(file) || !lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error("fonte ausente ou link");
      if (statSync(file).size > 10 * 1024 * 1024) throw new Error("fonte inválida no tema");
      const bytes = readFileSync(file);
      if (extension === ".woff2" ? bytes.subarray(0, 4).toString("ascii") !== "wOF2" : !["00010000", "74727565", "74797031"].includes(bytes.subarray(0, 4).toString("hex"))) throw new Error("fonte inválida no tema");
      fonts[key] = { data: bytes.toString("base64"), mime: extension === ".ttf" ? "font/ttf" : "font/woff2", format: extension === ".ttf" ? "truetype" : "woff2" };
    }
  }
  return { ...theme, name: theme.name.trim(), radius: Math.round(theme.radius * 100) / 100, fonts };
}

function gitValue(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false, windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("proveniência Git indisponível");
  return result.stdout.trim();
}

function cleanSource(root, target, ownedTarget) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error("status Git indisponível");
  const entries = (result.stdout || "").split(/\r?\n/).filter(Boolean);
  const allowed = relative(root, target).replace(/\\/g, "/");
  if (entries.some((entry) => !ownedTarget || entry.slice(3).replace(/\\/g, "/") !== allowed)) throw new Error("export exige repositório fonte limpo");
}

function exportThemeCss(theme) {
  const colors = theme.colors;
  const variables = [`--bg:${colors.background}`, `--panel:${colors.panel}`, `--panel2:${colors.panel2}`, `--ink:${colors.foreground}`, `--muted:${colors.muted}`, `--border:${colors.border}`, `--border2:${colors.border}`, `--accent:${colors.accent}`, `--accent-ink:${colors.accent}`, `--con:${colors.accent}`, `--chip:${colors.panel2}`, `--canvas:${colors.canvas}`, `--trail-radius:${theme.radius}px`];
  const fonts = [];
  for (const key of THEME_FONTS) {
    if (!theme.fonts[key]) continue;
    const family = `trail-${key}`;
    fonts.push(`@font-face{font-family:${family};src:url(data:${theme.fonts[key].mime};base64,${theme.fonts[key].data}) format('${theme.fonts[key].format}');font-display:swap}`);
    variables.push(`--trail-${key}:${family}`);
  }
  return `${fonts.join("")}\n:root,:root[data-theme="light"],:root[data-theme="dark"]{${variables.join(";")}}\nbody{font-family:var(--trail-sans,"Avenir Next","Segoe UI",system-ui,sans-serif)}.mono{font-family:var(--trail-mono,ui-monospace,"SF Mono",monospace)}.tab,.iconbtn,.searchbox input,.echip,.lchip,.lnk{border-radius:var(--trail-radius)}#themeBtn{display:none!important}`;
}

function moduleForPath(path) {
  const folders = String(path || "").split("/").filter(Boolean).slice(0, -1);
  return folders.length ? folders.slice(0, 2).join("/") : "root";
}

export function overviewGraph(wiring) {
  if (!wiring || wiring?.meta?.version !== 1 || !Array.isArray(wiring.nodes) || !Array.isArray(wiring.edges)) throw new Error("grafo estrutural inválido");
  const groups = new Map();
  const memberships = new Map();
  for (const node of wiring.nodes) {
    const module = moduleForPath(node.path);
    memberships.set(node.id, module);
    const group = groups.get(module) || { files: new Set(), symbols: 0, sources: new Set() };
    if (node.kind === "file") group.files.add(node.path);
    else group.symbols++;
    if (group.sources.size < 50) group.sources.add(node.path);
    groups.set(module, group);
  }
  const edgeCounts = new Map();
  for (const edge of wiring.edges) {
    const source = memberships.get(edge.source);
    const target = memberships.get(edge.target);
    if (!source || !target || source === target) continue;
    const key = `${source}\0${target}`;
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
  }
  const nodes = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([id, group]) => ({
    id: `module:${id}`,
    name: id,
    type: "concept",
    summary: `${group.files.size} ${group.files.size === 1 ? "arquivo" : "arquivos"}; ${group.symbols} ${group.symbols === 1 ? "símbolo" : "símbolos"}${group.files.size > group.sources.size ? `; ${group.sources.size} de ${group.files.size} fontes listadas` : ""}`,
    sources: [...group.sources].sort(),
  }));
  const edges = [...edgeCounts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
    const [source, target] = key.split("\0");
    return { source: `module:${source}`, target: `module:${target}`, relation: "uses", description: `${count} ${count === 1 ? "relação" : "relações"} entre módulos` };
  });
  return { meta: { nodeCount: nodes.length, edgeCount: edges.length, skippedFiles: 0, droppedEdges: 0 }, nodes, edges };
}

export function codeCanvasGraph(wiring) {
  if (!wiring || wiring?.meta?.version !== 1 || !Array.isArray(wiring.nodes) || !Array.isArray(wiring.edges)) throw new Error("grafo estrutural inválido");
  const files = wiring.nodes.filter((node) => node.kind === "file" && node.path);
  const fileByPath = new Map(files.map((node) => [node.path, node]));
  const symbolCounts = new Map(files.map((node) => [node.path, 0]));
  const fileForNode = new Map();
  for (const node of wiring.nodes) {
    const file = fileByPath.get(node.path);
    if (!file) continue;
    fileForNode.set(node.id, file);
    if (node.kind !== "file") symbolCounts.set(node.path, (symbolCounts.get(node.path) || 0) + 1);
  }
  const edgeCounts = new Map();
  for (const edge of wiring.edges) {
    const source = fileForNode.get(edge.source);
    const target = fileForNode.get(edge.target);
    if (!source || !target || source.id === target.id) continue;
    const relation = edge.relation || "uses";
    const key = `${source.id}\0${target.id}\0${relation}`;
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
  }
  const nodes = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => {
    const symbols = symbolCounts.get(file.path) || 0;
    return { id: file.id, name: file.name || basename(file.path), kind: file.kind, path: file.path, summary: `${symbols} ${symbols === 1 ? "símbolo" : "símbolos"} em ${file.path}`, sources: [file.path] };
  });
  const edges = [...edgeCounts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
    const [source, target, relation] = key.split("\0");
    return { source, target, relation, description: `${count} ${count === 1 ? "relação" : "relações"} entre arquivos` };
  });
  return { meta: { nodeCount: nodes.length, edgeCount: edges.length }, nodes, edges };
}

function wiringSnapshot(contextDir) {
  const file = join(contextDir, ".graph", "wiring.json");
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw new Error("grafo estrutural ausente ou link");
  const bytes = readFileSync(file);
  return { hash: createHash("sha256").update(bytes).digest("hex"), graph: JSON.parse(bytes) };
}

export function replaceViewerExact(page, expected, replacement, count, label) {
  const occurrences = page.split(expected).length - 1;
  if (occurrences !== count) throw new Error(`viewer Trail-Code incompatível: âncora ${label}`);
  return page.split(expected).join(replacement);
}

function replaceViewerOnce(page, expected, replacement, label) {
  return replaceViewerExact(page, expected, replacement, 1, label);
}

function patchLargeCodeViewer(page, codeCanvas) {
  const canvas = JSON.stringify(codeCanvas).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  page = replaceViewerOnce(page, "  codeGraph: ", `  codeCanvasGraph: ${canvas},\n  codeGraph: `, "code graph data");
  page = replaceViewerOnce(page, "async function Ae(){let e;if(F){if(!F.codeGraph)return null;e=F.codeGraph}else{let r=await fetch(\"/api/code-graph\");if(!r.ok)return null;e=await r.json()}let t=e.nodes.map(r=>({id:r.id,name:r.name,type:r.kind,summary:r.summary??r.signature??\"\",sources:[`${r.path} \\xB7 ${r.span}`]})),n=new Set(t.map(r=>r.id)),i=e.edges.filter(r=>n.has(r.source)&&n.has(r.target)).map(r=>({source:r.source,target:r.target,relation:r.relation,confidence:r.confidence}));return{meta:{nodeCount:t.length,edgeCount:i.length},nodes:t,edges:i}}", "async function Ae(e=\"codeGraph\"){let t;if(F){if(!F[e])return null;t=F[e]}else{let n=await fetch(\"/api/code-graph\");if(!n.ok)return null;t=await n.json()}let n=t.nodes.map(r=>({id:r.id,name:r.name,type:r.kind,summary:r.summary??r.signature??\"\",path:r.path,sources:[`${r.path} \\xB7 ${r.span}`]})),i=new Set(n.map(r=>r.id)),o=t.edges.filter(r=>i.has(r.source)&&i.has(r.target)).map(r=>({source:r.source,target:r.target,relation:r.relation,confidence:r.confidence,description:r.description}));return{meta:{nodeCount:n.length,edgeCount:o.length},nodes:n,edges:o}}", "code graph loader");
  page = replaceViewerOnce(page, 'E={tab:"context",context:null,code:null,outlineOpen:{}}', 'E={tab:"context",context:null,code:null,codeCanvas:null,codeDrill:null,outlineOpen:{}}', "viewer state");
  page = replaceViewerOnce(page, 'function J(){return E.tab==="context"?E.context:E.code}', 'function J(){return E.tab==="context"?E.context:E.tab==="code"?(E.codeDrill??E.codeCanvas??E.code):E.code}', "active graph");
  page = replaceViewerOnce(page, 'function P(e){at(_("detail"),E.tab==="context"?E.context:E.code,Ee(),e,t=>{E.tab==="outline"?(P(t),q(_("tree"),E.code,t,E.outlineOpen,P)):w.focus(t)})}w.onSelect=e=>P(e);', 'function P(e){at(_("detail"),E.tab==="context"?E.context:E.code,Ee(),e,t=>{E.tab==="outline"?(P(t),q(_("tree"),E.code,t,E.outlineOpen,P)):E.tab==="code"?openCodeFile(t):w.focus(t)})}function codeMode(){let e=_("codeMode");if(!e){e=document.createElement("button"),e.type="button",e.id="codeMode",e.style.cssText="position:absolute;right:54px;bottom:14px;z-index:2;font-size:11px;color:var(--muted);background:var(--panel);border:1px solid var(--border);border-radius:7px;padding:4px 8px",_("canvasWrap").appendChild(e)}e.hidden=E.tab!=="code",e.disabled=!E.codeDrill,e.textContent=E.codeDrill?`Voltar ao Código por arquivo (${E.codeDrillFile})`:"Código por arquivo. Selecione um arquivo para ver símbolos e relações.",e.onclick=()=>{if(E.codeDrill){E.codeDrill=null,E.codeDrillFile=null,dt("code")}}}function openCodeFile(e){let t=E.code?.nodes.find(n=>n.id===e);if(!t?.path)return;let n=new Set(E.code.nodes.filter(i=>i.path===t.path).map(i=>i.id)),o=new Set(n);for(let i of E.code.edges)if(n.has(i.source)||n.has(i.target))o.add(i.source),o.add(i.target);let i=E.code.edges.filter(r=>o.has(r.source)&&o.has(r.target));E.codeDrill={meta:{nodeCount:o.size,edgeCount:i.length},nodes:E.code.nodes.filter(r=>o.has(r.id)),edges:i},E.codeDrillFile=t.path,w.sim?.stop(),w.resetView(),w.setData(J(),"code"),w.reheat(),Me(),ae(),Ne(),Dt(),codeMode(),w.select(e)}w.onSelect=e=>{if(E.tab==="code"&&!E.codeDrill&&E.code?.nodes.some(t=>t.id===e&&t.type==="file")){openCodeFile(e);return}P(e)};', "detail navigation");
  page = replaceViewerOnce(page, 'function dt(e){E.tab=e,', 'function dt(e){w.sim?.stop(),e==="code"&&(E.codeDrill=null,E.codeDrillFile=null),E.tab=e,', "tab transition");
  page = replaceViewerOnce(page, 'Me(),ae(),Ne(),Dt()}', 'Me(),ae(),Ne(),Dt(),codeMode()}', "tab controls");
  page = replaceViewerOnce(page, 'async function pt(){let[e,t]=await Promise.all([Te(),Ae()]);E.context=e,E.code=t;', 'async function pt(){let[e,t,o]=await Promise.all([Te(),Ae(),Ae("codeCanvasGraph")]);E.context=e,E.code=t,E.codeCanvas=o??t;', "viewer data load");
  page = replaceViewerOnce(page, 'ke.addEventListener("keydown",e=>{if(e.key==="Enter"&&w.query){let t=w.firstMatch();t&&w.focus(t.id)}});', 'ke.addEventListener("keydown",e=>{if(e.key==="Enter"&&w.query){let t=E.tab==="code"?E.code?.nodes.find(n=>n.name.toLowerCase().includes(w.query.toLowerCase())):w.firstMatch();t&&(E.tab==="code"?openCodeFile(t.id):w.focus(t.id))}});', "symbol search");
  page = replaceViewerExact(page, "Math.max(.35,Math.min(3,", "Math.max(.03,Math.min(3,", 2, "limites de zoom");
  return page;
}

function decorateExport(page, theme, provenance, codeCanvas) {
  const metadata = `<div class="trail-provenance" ${EXPORT_MARKER}><span data-trail-project>${html(theme.name)}</span><span>ref ${html(provenance.ref)}</span><span>SHA ${html(provenance.sha)}</span><span>${html(provenance.date)}</span><span>tokens ${html(theme.source)}</span></div>`;
  const style = `<style id="trail-code-theme">${exportThemeCss(theme)}.trail-provenance{flex:none;display:flex;gap:8px;flex-wrap:wrap;padding:5px 16px;background:var(--panel2);border-bottom:1px solid var(--border);color:var(--muted);font:12px var(--trail-mono,ui-monospace,monospace)}.trail-provenance span{white-space:nowrap}@media (max-width:760px){.trail-provenance{padding:5px 10px;gap:4px;font-size:10px}.trail-provenance span{overflow:hidden;text-overflow:ellipsis;max-width:100%}.appbar{height:auto;min-width:0;flex-wrap:wrap;gap:8px;padding:8px 10px}.brand{min-width:0}.brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tabs{order:3;margin-left:0;min-width:0;max-width:100%;flex:1 1 auto}.tab{min-width:0;flex:1 1 auto;padding:5px 8px}.searchbox{order:4;min-width:0;flex:1 1 100%}.searchbox input{box-sizing:border-box;width:100%;min-width:0}}@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}</style>`;
  const nonce = randomBytes(18).toString("base64");
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">`;
  if (!["<title>graft viz</title>", "</style>", "</head>", 'data-tab="context">Context', 'data-tab="code">Code', 'data-tab="outline">Outline', '<b>graft</b>', '<header class="appbar">', '<script>window.__GRAFT_DATA__', '<script type="module">'].every((anchor) => page.includes(anchor))) throw new Error("viewer Trail-Code incompatível com exportação segura");
  page = patchLargeCodeViewer(page, codeCanvas);
  const themed = page.replace("<title>graft viz</title>", () => `<title>${html(theme.name)} | Trail Code</title>`).replace("</style>", () => `</style>${style}`).replace("</head>", () => `${csp}</head>`).replace('data-tab="context">Context', () => 'data-tab="context">Visão geral').replace('data-tab="code">Code', () => 'data-tab="code">Código').replace('data-tab="outline">Outline', () => 'data-tab="outline">Arquivos').replace('<b>graft</b>', () => '<b>Trail Code</b>').replace('<header class="appbar">', () => `${metadata}<header class="appbar">`).replace('<script>window.__GRAFT_DATA__', () => `<script nonce="${nonce}">window.__GRAFT_DATA__`).replace('<script type="module">', () => `<script nonce="${nonce}" type="module">`);
  return themed.replace("</body>", `<script nonce="${nonce}">window.addEventListener("load",()=>{document.documentElement.setAttribute("data-theme","light");const project=document.querySelector("[data-trail-project]")?.textContent?.trim();document.title=(project||"Mapa estrutural")+" | Trail Code"})</script></body>`);
}

export async function exportMap(root, out, theme, ref = null) {
  const checked = checkMap(root);
  if (!checked.fresh) throw new Error(`${checked.reason}; execute ensure antes de exportar`);
  if (typeof out !== "string" || !out) throw new Error("saída inválida");
  const target = isAbsolute(out) ? resolve(out) : resolve(root, out);
  if (extname(target).toLowerCase() !== ".html") throw new Error("saída deve ser arquivo .html");
  const parent = dirname(target);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw new Error("diretório de saída inexistente");
  assertDestinationWithoutLinks(parent);
  let ownedTarget = false;
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !readFileSync(target, "utf8").includes(EXPORT_MARKER)) throw new Error("recusa sobrescrever saída não gerada pelo Trail-Code");
    ownedTarget = true;
  }
  cleanSource(root, target, ownedTarget);
  const parsedTheme = validateTheme(theme, root);
  const sha = gitValue(root, ["rev-parse", "HEAD"]);
  const resolvedRef = ref || "HEAD";
  if (ref && gitValue(root, ["rev-parse", `${ref}^{commit}`]) !== sha) throw new Error("--ref deve resolver para o HEAD atual");
  const dist = resolve(dirname(trailBin()), "..");
  const state = await import(pathToFileURL(join(dist, "util", "state.js")).href);
  const exporter = await import(pathToFileURL(join(dist, "viz", "export.js")).href);
  const cache = join(root, "graft", ".cache");
  const temporary = mkdtempSync(join(tmpdir(), "trail-export-"));
  let locked = false;
  try {
    if (!state.acquireLockIn(cache)) throw new Error("mapa ocupado por outra sincronização");
    locked = true;
    const ready = checkMap(root, true);
    if (!ready.fresh) throw new Error(`mapa mudou antes da exportação: ${ready.reason}`);
    const before = wiringSnapshot(join(root, "graft"));
    const overview = overviewGraph(before.graph);
    const codeCanvas = codeCanvasGraph(before.graph);
    const result = exporter.exportViz({ viewerDir: join(dist, "viewer"), contextDir: join(root, "graft"), outDir: temporary, repoName: parsedTheme.name, subtitle: "", contextGraph: overview, tabs: ["context", "code", "outline"] });
    const page = decorateExport(readFileSync(result.file, "utf8"), parsedTheme, { ref: resolvedRef, sha, date: new Date().toISOString().slice(0, 10) }, codeCanvas);
    const final = checkMap(root, true);
    if (!final.fresh) throw new Error(`mapa mudou durante a exportação: ${final.reason}`);
    if (wiringSnapshot(join(root, "graft")).hash !== before.hash || gitValue(root, ["rev-parse", "HEAD"]) !== sha || (ref && gitValue(root, ["rev-parse", `${ref}^{commit}`]) !== sha)) throw new Error("fonte ou proveniência mudou durante a exportação");
    if (existsSync(target) && (!ownedTarget || lstatSync(target).isSymbolicLink() || !readFileSync(target, "utf8").includes(EXPORT_MARKER))) throw new Error("saída mudou durante a exportação");
    cleanSource(root, target, ownedTarget);
    const tempFile = join(parent, `.${basename(target)}.${process.pid}.tmp`);
    writeFileSync(tempFile, page, { flag: "wx" });
    try { renameSync(tempFile, target); } finally { if (existsSync(tempFile)) rmSync(tempFile, { force: true }); }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (locked) state.releaseLockIn(cache);
  }
  return { ok: true, file: target, sha, ref: resolvedRef };
}

function sessionId(event) {
  return String(event.session_id || event.thread_id || event.conversation_id || "unknown");
}

function dirtyMarker(root, event) {
  const id = createHash("sha256").update(`${sessionId(event)}\0${root}`).digest("hex").slice(0, 20);
  const probe = spawnSync("git", ["-C", root, "rev-parse", "--git-path", "trail-code"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false });
  if (probe.status !== 0 || !probe.stdout.trim()) return null;
  const metadata = isAbsolute(probe.stdout.trim()) ? probe.stdout.trim() : resolve(root, probe.stdout.trim());
  return join(metadata, `dirty-${id}`);
}

function markDirty(root, event) {
  const marker = dirtyMarker(root, event);
  if (!marker) return;
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "dirty\n");
}

function clearDirty(root, event) {
  const marker = dirtyMarker(root, event);
  if (marker) rmSync(marker, { force: true });
}

function isDirty(root, event) {
  const marker = dirtyMarker(root, event);
  return marker ? existsSync(marker) : false;
}

export function handleEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return [];
  const roots = repositoriesFor(event);
  const name = String(event.tool_name || "");
  const post = event.hook_event_name === "PostToolUse";
  const fileMutation = post && FILE_TOOLS.test(name);
  const shell = post && SHELL_TOOLS.test(name);
  return roots.map((root) => {
    if (fileMutation) markDirty(root, event);
    const shouldEnsure = fileMutation || (event.hook_event_name === "Stop" && isDirty(root, event));
    const result = shouldEnsure ? ensureMap(root) : checkMap(root);
    if (result.fresh && shouldEnsure) clearDirty(root, event);
    return { root, action: shouldEnsure ? "ensure" : shell ? "check-shell" : "check", ...result };
  });
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) return null;
  return args[index + 1];
}

function printResult(result) {
  process.stdout.write(`[trail-code] ${result.reason}\n`);
}

export function hookOutput(event, results) {
  const failures = results.filter((result) => !result.fresh);
  if (event?.hook_event_name === "PostToolUse" && failures.length) {
    const reasons = [...new Set(failures.map((result) => result.reason))].join("; ");
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `Trail-Code não confirmou o frescor do mapa: ${reasons}. Execute ensure antes de consultar ou concluir, somente com escrita autorizada.`,
      },
    })}\n`;
  }
  return results.map((result) => `[trail-code] ${result.reason}\n`).join("");
}

export function hookMain(raw) {
  let event;
  try { event = JSON.parse(raw || "{}"); } catch { return; }
  process.stdout.write(hookOutput(event, handleEvent(event)));
}

async function cli(args) {
  const command = args[0] || "hook";
  if (command === "hook") {
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => hookMain(raw));
    return;
  }
  const requested = option(args, "--repo");
  const resolved = rootResolution(requested);
  const root = resolved.root;
  if (!root) {
    printResult(resolved);
    process.exitCode = 2;
    return;
  }
  if (command === "check") {
    const result = checkMap(root); printResult(result); process.exitCode = result.fresh ? 0 : 2; return;
  }
  if (command === "ensure") {
    const result = ensureMap(root); printResult(result); process.exitCode = result.fresh ? 0 : 2; return;
  }
  if (command === "verify") {
    const result = verifyMap(root); printResult(result); process.exitCode = result.fresh ? 0 : 2; return;
  }
  if (command === "query") {
    const repoIndex = args.indexOf("--repo");
    const rest = args.slice(1).filter((_, index) => index !== repoIndex - 1 && index !== repoIndex);
    const query = queryMap(root, rest[0], rest.slice(1));
    if (query.stdout) process.stdout.write(query.stdout);
    if (!query.ok) printResult(query);
    process.exitCode = query.ok ? 0 : 2;
    return;
  }
  if (command === "export") {
    const out = option(args, "--out");
    const themePath = option(args, "--theme");
    const ref = option(args, "--ref");
    if (!out || !themePath) {
      printResult({ reason: "export requer --out <arquivo.html> e --theme <arquivo.json>" });
      process.exitCode = 2;
      return;
    }
    try {
      const theme = JSON.parse(readFileSync(themePath, "utf8"));
      const result = await exportMap(root, out, theme, ref);
      process.stdout.write(`[trail-code] exportado ${relative(root, result.file)} (${result.ref} ${result.sha})\n`);
    } catch (error) {
      printResult({ reason: error instanceof Error ? error.message : "falha ao exportar" });
      process.exitCode = 2;
    }
    return;
  }
  printResult({ reason: `comando inválido; use check, ensure, verify, query ou export (CLI ${CLI_VERSION})` });
  process.exitCode = 2;
}

function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) cli(process.argv.slice(2));
