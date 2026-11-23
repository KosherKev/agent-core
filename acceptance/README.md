# Locked acceptance suite

Run it: `npm test` (it is included) or `node --test "acceptance/**/*.test.js"`.

The builder may run this suite but must not edit it (rule R4). Protection: `.github/CODEOWNERS` plus the `protect-locked-paths` workflow, which fails an agent-authored pull request that changes any path in `.github/locked-paths.txt`. This is a skeleton: add checks here only through a human-authored change.
