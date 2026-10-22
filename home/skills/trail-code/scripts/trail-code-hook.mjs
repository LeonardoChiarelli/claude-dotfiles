#!/usr/bin/env node
// Compatibilidade com o nome instalado pelo primeiro piloto da LEO-399.
import { hookMain } from "./trail-code.mjs";

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => hookMain(raw));
