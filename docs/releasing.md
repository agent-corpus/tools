# Releasing

Releases are automated with [Changesets](https://github.com/changesets/changesets) and GitHub
Actions (`.github/workflows/release.yml`).

## Flow

1. Contributors add changesets to PRs (`npm run changeset`).
2. On every push to `main`, the release workflow:
   - if changesets are pending → opens/updates a **"Version Packages"** PR (bumps versions,
     updates changelogs);
   - if that PR was merged (no pending changesets) → runs `changeset publish`, which publishes
     every package whose version is not yet on npm, with provenance, and tags the release.
3. Merge the "Version Packages" PR to release.

## One-time setup

- npm org `agent-corpus` must exist and the publishing account must be a member with publish rights.
- Create an npm **automation/granular access token** with publish rights to the `@agent-corpus` scope
  and store it as the repository secret `NPM_TOKEN`.
- Repository settings → Actions → General → allow GitHub Actions to create and approve pull requests.
- Optional hardening: configure npm [trusted publishing](https://docs.npmjs.com/trusted-publishers)
  for each package and drop the long-lived token.

## Manual publish (emergency / first release)

```sh
npm login                       # account with access to the @agent-corpus org
npm run verify
npm run release                 # build + changeset publish
git push --follow-tags
```

Local publishes lack provenance; prefer CI.
