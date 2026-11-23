# Locked acceptance suite

Run it: `npm test` (it is included) or `node --test "acceptance/**/*.test.js"`.

The builder may run this suite but must not edit it (rule R4). Protection: `.github/CODEOWNERS` plus the `protect-locked-paths` workflow (a `pull_request_target` workflow, so its file comes from the base branch), which fails ANY pull request that changes a path in `.github/locked-paths.txt`, whoever or whatever authored it. The human exception is a manual merge by the owner. The tests run in a separate workflow (`tests.yml`) on plain `pull_request`. This is a skeleton: add checks here only through a human-authored change.

