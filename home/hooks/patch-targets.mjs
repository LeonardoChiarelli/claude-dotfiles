const HEADER = /^\s*\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+?)\s*$/;
const MOVE = /^\s*\*\*\*\s+Move\s+to:\s*(.+?)\s*$/;
const MARKER = /^\s*\*\*\*\s/;

function addedContent(lines) {
  return lines
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1))
    .join("\n");
}

// Extrai apenas a superfície declarada pelo formato V4A. Não interpreta hunks
// de Update, que não permitem reconstruir o resultado de forma determinística.
export function patchTargets(command) {
  if (typeof command !== "string") return [];
  const targets = [];
  const lines = command.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(HEADER);
    if (header) {
      const type = header[1].toLowerCase();
      const target = { type, path: header[2].trim() };
      if (type === "add") {
        const end = lines.slice(index + 1).findIndex((line) => MARKER.test(line));
        target.content = addedContent(lines.slice(index + 1, end < 0 ? undefined : index + 1 + end));
      }
      targets.push(target);
      continue;
    }
    const move = lines[index].match(MOVE);
    if (move) targets.push({ type: "move", path: move[1].trim() });
  }
  return targets;
}
