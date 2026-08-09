#!/usr/bin/env node
// PostToolUse hook: reminds (once per session) to run /sync-dotfiles when a
// write lands inside the synced part of ~/.claude. Watched list mirrors
// manifest.json "include" in the claude-dotfiles repo — keep them in sync.
// Memory writes (projects/**) are deliberately NOT watched: they change every
// session and would make the reminder pure noise; sync picks them up anyway.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch { process.exit(0); }
  const filePath = data.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const home = path.join(os.homedir(), '.claude');
  const rel = path.relative(home, path.resolve(filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);

  const watched = ['CLAUDE.md', 'RTK.md', 'settings.json', 'keybindings.json',
    'skills', 'agents', 'hooks', 'outcomes'];
  const top = rel.split(/[\\/]/)[0];
  if (!watched.includes(top)) process.exit(0);

  const flag = path.join(os.tmpdir(), `dotfiles-drift-${data.session_id || 'nosession'}`);
  if (fs.existsSync(flag)) process.exit(0);
  try { fs.writeFileSync(flag, '1'); } catch { /* best effort */ }

  console.log(JSON.stringify({
    systemMessage: `Config do Claude modificada (${top}). Roda /sync-dotfiles pra atualizar o repo claude-dotfiles.`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: 'A file under ~/.claude that is versioned in the claude-dotfiles repo was just modified. After finishing the current task, suggest running /sync-dotfiles to the user (do not run it unasked).',
    },
  }));
  process.exit(0);
});
