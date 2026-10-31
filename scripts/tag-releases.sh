#!/usr/bin/env bash
# Tag and push `<name>@<version>` for every workspace package that does not have that tag on origin.
# Idempotent: packages whose tag already exists are skipped. Run after a successful publish.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

# The tag lands on the commit being released (HEAD).
git config user.name >/dev/null 2>&1 || git config user.name "github-actions[bot]"
git config user.email >/dev/null 2>&1 || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for pkg in packages/*/package.json; do
  [ -f "$pkg" ] || continue
  [ "$(node -p "require('./$pkg').private === true")" = "true" ] && continue
  tag="$(node -p "const p=require('./$pkg'); p.name+'@'+p.version")"
  if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    echo "tag $tag already exists, skipping"
    continue
  fi
  git tag -a "$tag" -m "$tag"
  git push origin "refs/tags/$tag"
  echo "pushed tag $tag"
done
