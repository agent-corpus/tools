# Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets) and GitHub
Actions (`.github/workflows/release.yml`). `main` is protected: every change, including release
version bumps, lands through a pull request.

## Flow

1. **Describe changes.** Feature/fix PRs include a changeset (`npm run changeset`).
2. **Cut a release.** A maintainer opens a "release" PR:

   ```sh
   git checkout -b release/next
   npm run version-packages     # consumes changesets, bumps versions, updates CHANGELOGs
   npm install                  # refresh the lockfile if workspace versions changed
   git add -A && git commit -m "chore: version packages"
   ```

   CI runs on the PR; squash-merge it once green.
3. **Publish.** On the merge to `main`, the Release workflow runs `npm run verify`, then
   `changeset publish`, which publishes every package whose version is not on npm (with
   provenance) and pushes `@agent-corpus/<name>@<version>` git tags. Pushes that don't change a
   version make this job a no-op.

## One-time setup

### Authentication — pick one

**A. Trusted publishing (recommended, no stored secret).** After a package's first publish
(trusted publishers can only be attached to an existing package), open
`https://www.npmjs.com/package/@agent-corpus/<name>/access` → _Trusted Publisher_ → GitHub Actions:
organization `agent-corpus`, repository `tools`, workflow `release.yml`. Repeat for each package.

**B. Token.** Create a granular npm access token with publish rights on the `@agent-corpus` scope
and _bypass 2FA_ enabled, and store it as the repository secret `NPM_TOKEN`. The workflow uses it
automatically when present.

### First publish of a new package

Trusted publishing can't exist before the package does, so the first version needs either
`NPM_TOKEN` (option B) or a manual publish:

```sh
npm login
npm publish -w @agent-corpus/<name> --access public --otp=<code>
git tag @agent-corpus/<name>@<version> && git push origin --tags   # via a maintainer with bypass
```

### Branch protection

The `Protect main` ruleset requires a PR, the CI checks (`verify (20|22|24)`, `Package contents`),
resolved review threads, linear history (squash merges), and blocks force-pushes and deletion.
Required approvals are 0 while the project has a single maintainer; raise it in
_Settings → Rules → Rulesets_ when more maintainers join. Repository admins can bypass only when
merging a pull request, never by pushing directly.

When the organization allows Actions to create pull requests, the release PR can be automated with
`changesets/action`; until then the manual step above is used.
