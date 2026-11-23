import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseLocked(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function isLocked(file, locked) {
  return locked.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/** Returns the list of changed files that sit on locked paths. */
export function violations(changedFiles, locked) {
  return changedFiles.filter((f) => isLocked(f, locked));
}

/** Agent-authored: head branch prefix task/ or agent/, a bot actor, or an explicit flag. */
export function isAgentAuthored({ headRef = '', actor = '', flag = '' }) {
  return flag === 'true' || /^(task|agent)\//.test(headRef) || /\[bot\]$/.test(actor) || actor === 'claude';
}

// CLI: node locked-paths.mjs <base-sha> <head-sha>; env HEAD_REF, ACTOR, AGENT_AUTHORED
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) { console.error('usage: locked-paths.mjs <base> <head>'); process.exit(2); }
  const locked = parseLocked(readFileSync(new URL('../locked-paths.txt', import.meta.url), 'utf8'));
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const agent = isAgentAuthored({ headRef: process.env.HEAD_REF, actor: process.env.ACTOR, flag: process.env.AGENT_AUTHORED });
  const bad = violations(changed, locked);
  if (agent && bad.length) {
    console.error('Agent-authored change touches locked paths (R4):\n' + bad.map((f) => `  ${f}`).join('\n'));
    process.exit(1);
  }
  console.log(agent ? 'agent-authored: no locked paths touched' : `not agent-authored; ${bad.length} locked file(s) changed (human review via CODEOWNERS)`);
}
