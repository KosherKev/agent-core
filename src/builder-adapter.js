import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createJournal } from './journal.js';
import { validateGrant } from './validators.js';
import { isFreeModel, checkBaseUrl } from './builder-config.js';
import { makeRedactor, redactError } from './builder-redact.js';
import { confine, ConfineError, isReadDenied } from './builder-confine.js';
import { BUILDER_CAPABILITIES, validateCapabilities } from './builder-capabilities.js';

/** Documented exit codes. */
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, RATE_LIMITED: 3 });
export const LIMITS = Object.freeze({ MAX_MALFORMED_IN_ROW: 3, MAX_TRUNCATIONS: 1, MAX_FILE_BYTES: 200000, MAX_READ_BYTES: 50000 });
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop']);

/** Where the contract was awkward for this builder. Journaled once per run as issues of kind `contract-gap`. */
export const CONTRACT_GAPS = Object.freeze([
  { file: 'schemas/v1/run-journal-entry.schema.json', reason: 'issue entries have no `kind` field (category is bug/risk/improvement and unevaluatedProperties is false), so rate-limit and contract-gap kinds are encoded as a "[kind: X]" prefix in the description.' },
  { file: 'schemas/v1/run-journal-entry.schema.json', reason: 'there is no failure entry kind; failures are recorded as an `attempt` with outcome "failed" (or "blocked").' },
  { file: 'schemas/v1/grant.schema.json', reason: 'there is no task-spec schema: a grant has scope, budget and expiry but no goal, repo identity or branch. The adapter takes {grant, repo, goal, workdir} and validates only the grant part.' },
  { file: 'schemas/v1/grant.schema.json', reason: 'scope.paths semantics are unspecified (glob vs prefix); the adapter treats entries as relative directory/file prefixes ("." or "*" means everything).' },
  { file: 'docs/adr/0003-run-journal.md', reason: 'the journal guarantee is in-process only; the adapter mirrors every appended entry to an untracked .agent-runs/<run_id>.jsonl, which carries no append-only protection.' },
  { file: 'src/self-model.js', reason: 'the self-model indexes only top-level src/*.js modules and has no capabilities field, so the builder capability manifests cannot be listed there.' },
  { file: 'schemas/v1/capability-manifest.schema.json', reason: 'there is no registry or place to publish manifests; the adapter validates them and writes them to .agent-runs/<run_id>.capabilities.json.' },
]);

const SYSTEM_PROMPT = [
  'You are a software builder working inside one git worktree on a task branch.',
  'You can only use the provided tools: read_file, write_file, list_dir. Paths are relative to the worktree root.',
  'You cannot touch acceptance/, .github/ or anything outside the allowed paths. Work in small steps.',
  'When the task is done, reply with a short plain-text summary and no tool calls.',
].join('\n');

const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a UTF-8 text file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List a directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

const NAME = '[A-Za-z0-9_.-]+';
const GH_FORMS = [
  new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/?$`),
  new RegExp(`^git@github\\.com:(${NAME})/(${NAME})/?$`),
  new RegExp(`^ssh://git@github\\.com/(${NAME})/(${NAME})/?$`),
];

/**
 * Parse a git remote URL (GitHub https, scp-style ssh and ssh:// forms only) to { owner, repo }, or null.
 * Anything else (other hosts, embedded credentials, extra path segments, dot segments) is unparseable.
 */
export function parseGithubRemote(url) {
  if (typeof url !== 'string') return null;
  for (const re of GH_FORMS) {
    const m = url.trim().match(re);
    if (!m) continue;
    const owner = m[1]; const repo = m[2].replace(/\.git$/, '');
    if (!repo || /^\.+$/.test(repo) || /^\.+$/.test(owner)) return null;
    return { owner, repo };
  }
  return null;
}

/**
 * Derive the repos a worktree really points at from its git remotes (every remote, fetch and push URLs),
 * never from task input. Returns { ok: true, repos: ['owner/repo', ...] } or { ok: false, why }.
 * No remote, any unparseable remote, a workdir that is not the repo top level, or any git error: not ok.
 */
export function remoteRepos(workdir) {
  try {
    const top = realpathSync(git(workdir, ['rev-parse', '--show-toplevel']));
    if (top !== realpathSync(workdir)) return { ok: false, why: 'workdir is not the top level of its git repository' };
    const names = git(workdir, ['remote']).split('\n').map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) return { ok: false, why: 'workdir has no git remote' };
    const repos = new Set();
    for (const n of names) {
      const urls = [...git(workdir, ['remote', 'get-url', '--all', n]).split('\n'), ...git(workdir, ['remote', 'get-url', '--push', '--all', n]).split('\n')];
      for (const u of urls.map((x) => x.trim()).filter(Boolean)) {
        const r = parseGithubRemote(u);
        if (!r) return { ok: false, why: `git remote "${n}" is not a recognised GitHub URL` };
        repos.add(`${r.owner}/${r.repo}`);
      }
    }
    return repos.size ? { ok: true, repos: [...repos] } : { ok: false, why: 'workdir has no git remote' };
  } catch {
    return { ok: false, why: 'could not read the workdir git remote' };
  }
}

const git = (cwd, args, extra = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra }).trim();
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Short plain-text summary of journal entries for humans. */
export function summarizeJournal(entries) {
  const counts = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const lines = [`journal: ${entries.length} entries (${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(', ')})`];
  for (const e of entries) {
    if (e.kind === 'reservation') lines.push(`  reservation: ${e.doubt} -> ${e.action_taken}`);
    else if (e.kind === 'attempt') lines.push(`  attempt [${e.outcome}]: ${e.tried} (${e.reason})`);
    else lines.push(`  issue [${e.category}/${e.severity}]: ${e.description}`);
  }
  return lines.join('\n');
}

/**
 * Run one builder task. Never throws for operational failures: it returns
 * { exit_code, status, ... }. All text that reaches the journal, commits,
 * results or thrown errors is passed through the key redactor.
 *
 * task: { repo, goal, grant, workdir, branch? }  (contract shape: grant is the schemas/v1 grant)
 * opts: { fetch, sleep, now, journal }  (test seams)
 */
export async function runBuilder({ config, task }, opts = {}) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const redact = makeRedactor(config.apiKey);
  const journal = opts.journal ?? createJournal();
  const runId = opts.runId ?? `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  let seq = 0;
  let runDir = null;
  const written = new Set();
  const result = { run_id: runId, status: 'failed', exit_code: EXIT.FAILED, commit: null, files_written: [], journal_path: null, capabilities_path: null };

  const clean = (v) => (typeof v === 'string' ? redact(v) : v);
  const rec = (entry) => {
    const e = { schema_version: '1', id: `${runId}-${String(++seq).padStart(3, '0')}`, run_id: runId, at: new Date().toISOString(), ...Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, clean(v)])) };
    const stored = journal.append(e);
    if (runDir) { try { appendFileSync(result.journal_path, JSON.stringify(stored) + '\n'); } catch { /* mirror is best effort */ } }
    return stored;
  };
  const attempt = (tried, outcome, reason) => rec({ kind: 'attempt', tried, outcome, reason });
  const issue = (kind, category, severity, description, suggested_fix) => rec({ kind: 'issue', category, severity, description: `[kind: ${kind}] ${description}`, suggested_fix });
  const finish = (status, exit_code) => {
    result.status = status; result.exit_code = exit_code;
    result.entries = journal.read({ run_id: runId });
    result.summary = summarizeJournal(result.entries);
    return result;
  };
  const refuse = (why) => { attempt('preflight checks', 'blocked', why); return finish('refused', EXIT.REFUSED); };

  try {
    // ---- Preflight: everything here happens before any network call. ----
    const workdir = task?.workdir;
    if (workdir && existsSync(workdir)) {
      runDir = join(workdir, '.agent-runs');
      try {
        mkdirSync(runDir, { recursive: true });
        result.journal_path = join(runDir, `${runId}.jsonl`);
        writeFileSync(result.journal_path, '');
      } catch { runDir = null; result.journal_path = null; }
    }
    rec({ kind: 'reservation', doubt: 'Free and third-party models may retain or train on prompts; the data policy is not guaranteed.', action_taken: `Using model ${config.model}; free models are restricted to allowlisted public repos and the key is never journaled.` });
    for (const g of CONTRACT_GAPS) issue('contract-gap', 'improvement', 'low', `${g.file}: ${g.reason}`, 'Decide whether to extend the contract in a new schema version; the adapter works around it for now.');

    if (config.role !== 'builder') return refuse('role is not builder');
    const bu = checkBaseUrl(config.base_url);
    if (!bu.ok) return refuse(bu.why);
    if (!config.apiKey) return refuse('OPENROUTER_API_KEY is not set');
    if (!task || typeof task.goal !== 'string' || !task.goal.trim() || typeof task.repo !== 'string' || !task.repo.trim() || !workdir) return refuse('task needs repo, goal, grant and workdir');
    const repoName = basename(task.repo.replace(/\/+$/, ''));
    if (isFreeModel(config.model)) {
      // Free endpoints have no stated data policy: decide from the workdir's real git remotes, never from task.repo.
      const rr = remoteRepos(workdir);
      if (!rr.ok) return refuse(`free model ${config.model} refused: ${rr.why}`);
      const allow = config.free_model_repo_allowlist.map((a) => a.toLowerCase());
      const bad = rr.repos.filter((r) => !allow.includes(r.toLowerCase()) && !allow.includes(r.split('/')[1].toLowerCase()));
      if (bad.length) return refuse(`free model ${config.model} may only run on allowlisted repos; git remote repo "${bad[0]}" is not on FREE_MODEL_REPO_ALLOWLIST`);
    }
    const g = validateGrant(task.grant);
    if (!g.valid) return refuse(`grant invalid: ${g.errors.join('; ')}`);
    if (Date.parse(task.grant.expires_at) <= (opts.now ?? Date.now)()) return refuse('grant has expired');
    if (!task.grant.scope.repos.includes(repoName) && !task.grant.scope.repos.includes(task.repo)) return refuse(`repo "${repoName}" is not in the grant's scope`);
    if (!task.grant.allowed_risk_tiers.includes('low')) return refuse('grant does not allow risk tier low');
    if (!existsSync(workdir)) return refuse('workdir does not exist');
    let branch;
    try { branch = git(workdir, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return refuse('workdir is not a git worktree'); }
    if (PROTECTED_BRANCHES.has(branch) || branch === 'HEAD') return refuse(`refusing to build on branch "${branch}"; use a task branch`);
    if (task.branch && task.branch !== branch) return refuse(`workdir is on "${branch}", expected "${task.branch}"`);

    // Capability manifests (R1): validate with the existing validators, then persist.
    const caps = validateCapabilities();
    const badCap = caps.find((c) => !c.valid);
    if (badCap) return refuse(`own capability manifest invalid: ${badCap.name}`);
    if (runDir) {
      result.capabilities_path = join(runDir, `${runId}.capabilities.json`);
      writeFileSync(result.capabilities_path, JSON.stringify(BUILDER_CAPABILITIES, null, 2) + '\n');
    }
    result.capabilities = BUILDER_CAPABILITIES.map((c) => c.name);

    // ---- Tool-using loop ----
    const budget = task.grant.budget.max_tool_calls;
    let toolCalls = 0; let malformedInRow = 0; let truncations = 0; let steps = 0;
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: task.goal }];
    const allowed = task.grant.scope.paths;

    const runTool = (name, args) => {
      if (name === 'read_file') {
        const { abs } = confine(workdir, args.path);
        // Open first, check it is a regular file, then read at most MAX_READ_BYTES (no whole-file read, no FIFO hang).
        const fd = openSync(abs, 'r');
        try {
          if (!fstatSync(fd).isFile()) throw new ConfineError('not a regular file');
          const buf = Buffer.alloc(LIMITS.MAX_READ_BYTES);
          const n = readSync(fd, buf, 0, LIMITS.MAX_READ_BYTES, 0);
          return buf.subarray(0, n).toString('utf8');
        } finally { closeSync(fd); }
      }
      if (name === 'list_dir') {
        const { abs } = confine(workdir, args.path);
        return readdirSync(abs).filter((n) => n !== '.agent-runs' && !isReadDenied(n)).sort().map((n) => (statSync(join(abs, n)).isDirectory() ? `${n}/` : n)).join('\n');
      }
      const { abs, rel } = confine(workdir, args.path, { write: true, allowedPaths: allowed });
      if (Buffer.byteLength(args.content) > LIMITS.MAX_FILE_BYTES) throw new ConfineError('file too large');
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.content);
      written.add(rel);
      return `wrote ${rel} (${Buffer.byteLength(args.content)} bytes)`;
    };

    const stop = (status, code, why) => { commitWork(status); return finish(status, code); };
    const commitWork = (status) => {
      if (written.size === 0) return;
      try {
        const files = [...written].sort();
        git(workdir, ['add', '--', ...files]);
        const msg = redact(`builder(${status}): ${task.goal.split('\n')[0].slice(0, 60)}`);
        git(workdir, ['-c', 'user.name=agent-builder', '-c', 'user.email=agent-builder@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg, '--', ...files]);
        result.commit = git(workdir, ['rev-parse', 'HEAD']);
        result.files_written = files;
        attempt('commit work so far on the task branch', 'ok', `committed ${files.length} file(s) as ${result.commit.slice(0, 12)}`);
      } catch (err) {
        attempt('commit work so far on the task branch', 'failed', `git commit failed: ${redactError(err, redact).message.slice(0, 300)}`);
      }
    };

    for (;;) {
      steps += 1;
      const call = await requestModel({ config, messages, fetchFn, sleep, redact, rec: { attempt, issue }, step: steps });
      if (call.stop) return stop(call.stop.status, call.stop.code);
      const { choice } = call;
      const msg = choice.message ?? {};
      const finishReason = choice.finish_reason;

      if (msg.refusal || finishReason === 'content_filter') {
        attempt(`model step ${steps}`, 'blocked', `model refused: ${String(msg.refusal ?? 'content filter').slice(0, 200)}`);
        issue('refusal', 'risk', 'low', 'The model refused the task.', 'Rephrase the goal or try a different model; nothing was forced.');
        return stop('failed', EXIT.FAILED);
      }
      if (finishReason === 'length') {
        truncations += 1;
        attempt(`model step ${steps}`, 'failed', `response truncated (finish_reason=length), truncation ${truncations}`);
        if (truncations > LIMITS.MAX_TRUNCATIONS) {
          issue('truncation', 'bug', 'medium', 'Repeated truncated responses; stopping.', 'Use a model with a larger output limit or split the task.');
          return stop('failed', EXIT.FAILED);
        }
        messages.push({ role: 'user', content: 'Your previous reply was cut off and discarded. Continue with smaller steps (shorter files).' });
        continue;
      }

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (calls.length === 0) {
        if (typeof msg.content !== 'string' || !msg.content.trim()) {
          attempt(`model step ${steps}`, 'failed', 'empty response with no tool calls');
          return stop('failed', EXIT.FAILED);
        }
        attempt(`model step ${steps}: final answer`, 'ok', `model finished: ${msg.content.trim().slice(0, 200)}`);
        return stop('completed', EXIT.OK);
      }

      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const tc of calls) {
        const id = typeof tc?.id === 'string' ? tc.id : `call_${steps}`;
        const reply = (content) => messages.push({ role: 'tool', tool_call_id: id, content: redact(String(content)) });
        let name; let args;
        try {
          name = tc?.function?.name;
          if (!TOOLS.some((t) => t.function.name === name)) throw new Error(`unknown tool "${String(name).slice(0, 40)}"`);
          args = JSON.parse(tc.function.arguments);
          if (!args || typeof args !== 'object' || typeof args.path !== 'string' || (name === 'write_file' && typeof args.content !== 'string')) throw new Error('arguments do not match the tool schema');
        } catch (err) {
          malformedInRow += 1;
          attempt(`tool call ${String(name).slice(0, 40)} (step ${steps})`, 'failed', `malformed tool call: ${redactError(err, redact).message.slice(0, 200)}`);
          reply(`ERROR: malformed tool call (${err.message}). Send valid JSON arguments for a known tool.`);
          if (malformedInRow >= LIMITS.MAX_MALFORMED_IN_ROW) {
            issue('malformed-tool-calls', 'bug', 'medium', `${malformedInRow} malformed tool calls in a row; stopping.`, 'Try a model with better tool-calling support.');
            return stop('failed', EXIT.FAILED);
          }
          continue;
        }
        malformedInRow = 0;
        if (toolCalls >= budget) {
          attempt(`tool ${name}`, 'blocked', `grant budget of ${budget} tool calls exhausted`);
          return stop('failed', EXIT.FAILED);
        }
        toolCalls += 1;
        try {
          const out = runTool(name, args);
          attempt(`tool ${name} ${args.path}`, 'ok', String(out).split('\n')[0].slice(0, 120));
          reply(out);
        } catch (err) {
          const blocked = err instanceof ConfineError && err.blocked;
          attempt(`tool ${name} ${String(args.path).slice(0, 80)}`, blocked ? 'blocked' : 'failed', redactError(err, redact).message.slice(0, 200));
          reply(`ERROR: ${err.message}`);
        }
      }
    }
  } catch (err) {
    const safe = redactError(err, redact);
    try { attempt('run', 'failed', `unexpected error: ${safe.message.slice(0, 300)}`); } catch { /* journal itself broken */ }
    result.error = safe.message;
    return finish('failed', EXIT.FAILED);
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP date) to milliseconds, or null. */
export function parseRetryAfter(v, now = Date.now()) {
  if (v === null || v === undefined || v === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(v).trim())) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/**
 * One chat/completions request, with bounded rate-limit handling.
 * On HTTP 429 (or a daily-cap error body): honour Retry-After, else exponential
 * backoff from base_delay_ms; retry at most rate_limit.max_retries times; a wait
 * above max_delay_ms, or a daily cap, stops immediately. Stopping journals an
 * issue of kind rate-limit and returns exit code RATE_LIMITED.
 * Returns { choice } or { stop: {status, code} } after journaling why.
 */
async function requestModel({ config, messages, fetchFn, sleep, rec, redact, step }) {
  const body = { model: config.model, messages, tools: TOOLS };
  if (Object.keys(config.provider).length) body.provider = config.provider;
  const rl = config.rate_limit;
  let retries = 0;
  for (;;) {
    let res; let text;
    try {
      res = await fetchFn(`${config.base_url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(config.request_timeout_ms),
      });
      text = await res.text();
    } catch (err) {
      rec.attempt(`model step ${step}`, 'failed', `network error: ${redactError(err, redact).message.slice(0, 200)}`);
      return { stop: { status: 'failed', code: EXIT.FAILED } };
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const detail = redact(String(json?.error?.message ?? text).slice(0, 200));
      const dailyCap = /per[- ]day|daily/i.test(detail);
      if (res.status === 429 || dailyCap) {
        const hinted = parseRetryAfter(res.headers.get('retry-after'));
        const delay = hinted ?? Math.min(rl.base_delay_ms * 2 ** retries, rl.max_delay_ms);
        const giveUp = dailyCap ? 'daily cap reached' : retries >= rl.max_retries ? `still limited after ${retries} retries` : delay > rl.max_delay_ms ? `Retry-After ${delay}ms exceeds the ${rl.max_delay_ms}ms cap` : null;
        if (!giveUp) {
          retries += 1;
          rec.attempt(`model step ${step}`, 'failed', `HTTP ${res.status} rate limited; waiting ${delay}ms (retry ${retries}/${rl.max_retries}): ${detail}`);
          await sleep(delay);
          continue;
        }
        rec.attempt(`model step ${step}`, 'blocked', `HTTP ${res.status} rate limited: ${giveUp}: ${detail}`);
        rec.issue('rate-limit', 'risk', 'medium', `Stopped after rate limiting (${giveUp}; ${retries} retries). Work so far is committed on the branch.`, 'Wait for the limit to reset (or add credits), then rerun the task on the same branch.');
        return { stop: { status: 'rate-limited', code: EXIT.RATE_LIMITED } };
      }
      const notFound = res.status === 404 || /model.*(not found|does not exist|not a valid|unavailable)|no endpoints found/i.test(detail);
      rec.attempt(`model step ${step}`, 'failed', notFound ? `model not found or unavailable (HTTP ${res.status}): ${detail}` : `HTTP ${res.status}: ${detail}`);
      return { stop: { status: 'failed', code: EXIT.FAILED } };
    }
    const choice = json?.choices?.[0];
    if (!choice || typeof choice !== 'object') {
      rec.attempt(`model step ${step}`, 'failed', 'response has no choices (malformed)');
      return { stop: { status: 'failed', code: EXIT.FAILED } };
    }
    return { choice };
  }
}
