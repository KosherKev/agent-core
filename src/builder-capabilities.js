import { validateManifest } from './validators.js';

const undo = ['Run `git revert` on the builder commit(s) on the task branch, or `git reset` the unpushed task branch to its base.', 'Nothing outside the task worktree is ever written, so no other reversal is needed.'];

/** Capability manifests for what the builder adapter can do (R1: every one carries undo). */
export const BUILDER_CAPABILITIES = [
  { schema_version: '1', name: 'builder.write-file', version: '1.0.0', scopes: ['repo:write:task-worktree'], inputs: [{ name: 'path', type: 'string', required: true }, { name: 'content', type: 'string', required: true }], outputs: [{ name: 'bytes_written', type: 'integer' }], undo: { reversal_steps: undo }, risk_tier: 'low' },
  { schema_version: '1', name: 'builder.read-file', version: '1.0.0', scopes: ['repo:read:task-worktree'], inputs: [{ name: 'path', type: 'string', required: true }], outputs: [{ name: 'content', type: 'string' }], undo: { reversal_steps: ['Read-only: nothing to undo.'] }, risk_tier: 'low' },
  { schema_version: '1', name: 'builder.list-dir', version: '1.0.0', scopes: ['repo:read:task-worktree'], inputs: [{ name: 'path', type: 'string', required: true }], outputs: [{ name: 'entries', type: 'array' }], undo: { reversal_steps: ['Read-only: nothing to undo.'] }, risk_tier: 'low' },
  { schema_version: '1', name: 'builder.commit-branch', version: '1.0.0', scopes: ['repo:commit:task-branch'], inputs: [{ name: 'message', type: 'string', required: true }], outputs: [{ name: 'commit', type: 'string' }], undo, risk_tier: 'low' },
];

export function validateCapabilities(list = BUILDER_CAPABILITIES) {
  return list.map((m) => ({ name: m.name, ...validateManifest(m) }));
}
