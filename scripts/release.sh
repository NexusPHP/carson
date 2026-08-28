#!/usr/bin/env bash
# Bumps package.json and the lockfile to the given version. Nothing is
# committed, tagged, or pushed.
set -euo pipefail

VERSION="${1:?usage: scripts/release.sh X.Y.Z}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "version must be X.Y.Z, got \"$VERSION\"" >&2
  exit 1
}

if git ls-remote --exit-code origin "refs/tags/v$VERSION" > /dev/null 2>&1; then
  echo "tag v$VERSION already exists on origin" >&2
  exit 1
fi

npm version "$VERSION" --no-git-tag-version --allow-same-version
