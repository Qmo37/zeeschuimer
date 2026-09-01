#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(git rev-parse --show-toplevel)"
cd "$repo_dir"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/digitalmethodsinitiative/zeeschuimer.git
fi
git fetch upstream --prune

base_ref="upstream/master"
head_ref="HEAD"
behind="$(git rev-list --count "$head_ref..$base_ref")"
ahead="$(git rev-list --count "$base_ref..$head_ref")"
upstream_sha="$(git rev-parse "$base_ref")"
local_sha="$(git rev-parse "$head_ref")"

printf 'local=%s\nupstream=%s\nahead=%s\nbehind=%s\n' \
  "$local_sha" "$upstream_sha" "$ahead" "$behind"
if [ "$behind" -gt 0 ]; then
  printf 'Upstream updates are available; review and merge them into the FIMI branch manually.\n'
else
  printf 'No upstream commits are pending.\n'
fi
