#!/usr/bin/env bash
# Bumps package.json, the lockfile, and the trailing "# vX.Y.Z" pin comments
# in the docs to the given version. Nothing is committed, tagged, or pushed.
set -euo pipefail

VERSION="${1:?usage: .github/scripts/release.sh X.Y.Z}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "version must be X.Y.Z, got \"$VERSION\"" >&2
  exit 1
}

if git ls-remote --exit-code origin "refs/tags/v$VERSION" > /dev/null 2>&1; then
  echo "tag v$VERSION already exists on origin" >&2
  exit 1
fi

npm version "$VERSION" --no-git-tag-version --allow-same-version

PIN_FILES=(README.md docs/install/index.html)
sed -i.bak -E "s/# v[0-9]+\.[0-9]+\.[0-9]+/# v$VERSION/g" "${PIN_FILES[@]}"
rm -f "${PIN_FILES[@]/%/.bak}"
