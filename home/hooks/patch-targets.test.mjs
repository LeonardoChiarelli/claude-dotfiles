import assert from "node:assert/strict";
import test from "node:test";
import { patchTargets } from "./patch-targets.mjs";

test("extrai todos os alvos V4A de Add, Update, Delete e Move", () => {
  const command = [
    "*** Begin Patch",
    "*** Add File: config/.env.local",
    "+VALUE=fixture",
    "*** Update File: footage/intro.mp4",
    "@@",
    "*** Delete File: assets/old.mp4",
    "*** Update File: manifests/manifest.json",
    "*** Move to: manifests/renamed.json",
    "*** End Patch",
  ].join("\n");

  assert.deepEqual(
    patchTargets(command).map(({ type, path }) => [type, path]),
    [
      ["add", "config/.env.local"],
      ["update", "footage/intro.mp4"],
      ["delete", "assets/old.mp4"],
      ["update", "manifests/manifest.json"],
      ["move", "manifests/renamed.json"],
    ],
  );
});

test("reconstrói somente o conteúdo completo de Add File", () => {
  const command = [
    "*** Begin Patch",
    "*** Add File: manifest.json",
    "+{",
    "+  \"source\": {},",
    "+  \"profiles\": []",
    "+}",
    "*** Update File: other.json",
    "@@",
    "*** End Patch",
  ].join("\n");

  assert.equal(patchTargets(command)[0].content, '{\n  "source": {},\n  "profiles": []\n}');
  assert.equal(patchTargets(command)[1].content, undefined);
});

test("preserva caminhos Windows absolutos, CRLF e destino de Move", () => {
  const command = [
    "*** Begin Patch",
    "*** Update File: C:\\repo\\config\\settings.json",
    "*** Move to: D:\\archive\\settings.json",
    "@@",
    "*** End Patch",
  ].join("\r\n");

  assert.deepEqual(patchTargets(command), [
    { type: "update", path: "C:\\repo\\config\\settings.json" },
    { type: "move", path: "D:\\archive\\settings.json" },
  ]);
});

test("ignora command ausente ou não textual sem lançar", () => {
  for (const command of [undefined, null, {}, [], 42]) {
    assert.deepEqual(patchTargets(command), []);
  }
});
