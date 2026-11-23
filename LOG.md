# LOG

## 2026-11-23
- Files touched: package.json, package-lock.json, .gitignore, schemas/v1/*.schema.json (5), src/{validators,journal,self-model}.js, scripts/build-self-model.js, self-model.json, fixtures/** (5 schemas, valid+invalid), test/*.test.js, acceptance/{README.md,contracts.test.js}, docs/adr/0001-0005, .github/{CODEOWNERS,locked-paths.txt,scripts/locked-paths.mjs,workflows/protect-locked-paths.yml}, README.md, LOG.md
- What changed: new repo structure; versioned (v1) JSON Schemas with ajv validators for capability manifest, extension request, run journal entry (reservation/attempt/issue), grant, self-model; append/read-only journal API; deterministic self-model generator with staleness check; one ADR per contract; locked acceptance suite skeleton with CODEOWNERS and a CI workflow that fails agent-authored changes to locked paths; README (seven seams).
- Acceptance criteria (pass/fail each):
  - (a) valid and invalid fixtures for every schema, all behave: PASS
  - (b) manifest without undo rejected: PASS
  - (c) journal has no edit/delete through the API: PASS
  - (d) acceptance-suite paths protected in CI: PASS (workflow written and its logic unit-tested and exercised locally; the workflow itself has not run on GitHub)
  - (e) one ADR per contract: PASS (5 contracts, 5 ADRs)
  - (f) README explains the seven seams: PASS
  - (g) LOG.md updated: PASS
  - (h) tests and build pass: PASS (67 tests, 0 failures; `npm run build` and `npm run check:self-model` succeed)
- Deviations:
  - The spec never lists "seven seams". They were inferred as: capability manifest, extension request, run journal, grant, self-model, locked acceptance suite, overseer/gate boundary (R2/R4). The last is documented only; no code.
  - This branch itself changes locked paths (it creates them), so the CI guard will fail this agent-authored PR by design; Kevin reviews and merges it as the human exception.
  - Locked paths are `acceptance/` and `.github/`. Schemas are not locked.
  - "Agent-authored" is detected by head branch prefix task/ or agent/, bot actor, or an `agent-authored` label. Branch protection requiring the check and CODEOWNERS review must be enabled in GitHub settings by Kevin.
  - ajv strict mode is on except `strictRequired`, which is off so `anyOf: [{required}]` can express the undo rule.
  - ajv pinned at 8.20.0 (8.17.1 had an npm audit advisory; not exploitable here as `$data` is unused).
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not merged.
- Next step: Kevin reviews and merges; enable branch protection and CODEOWNERS review.
