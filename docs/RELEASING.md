# Releasing

Versions are OpenVessel's own semver. The Node.js version it ports is shown in the release title
(`OpenVessel 1.0.0 — Node.js 22.23.4`), the release notes, and `package.json` → `openvessel.node`.

| Change | Version |
|---|---|
| Fix, or following a Node.js patch release | patch |
| New feature, or following a Node.js minor release | minor |
| Break the host API or the embedding requirements, or move to a new Node.js major | major |

The build needs `vendor/` (Docker, once) and the cached compat packages, so releases are built on a
maintainer's machine, not in CI.

1. Land everything on `main` and push it (releases are cut from `main`).
2. Set the version in `package.json` and `package-lock.json`; make sure `openvessel.node`
   equals `NODE_VERSION` in `src/node/version.ts`; add a section to `CHANGELOG.md`.
3. `npm run build && node scripts/build-types.mjs && npm run typecheck && npm test`
4. Re-run the Node suite and the corpus if the runtime changed, and update the numbers in
   `README.md` and `docs/compatibility.md`.
5. `npm pack` → `openvessel-<version>.tgz`.
6. Commit as `Release <version>`, tag `v<version>`, push the commit and the tag.
7. `gh release create v<version> openvessel-<version>.tgz --title "OpenVessel <version> — Node.js <node>" --notes-file <notes>`
   (add `--prerelease` for a release candidate).
8. Optional: `npm publish --provenance --access public` of the same tarball.
