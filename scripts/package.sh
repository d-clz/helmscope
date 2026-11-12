#!/usr/bin/env bash
# Packs dist/bin/<platform>/ into the three release archives and writes
# dist/SHA256SUMS covering the archives and the bare binaries (security teams
# usually allowlist by the hash of the .exe itself, not the zip).
#
# usage: scripts/package.sh <version>        (run from the repo root, after make binaries)
# env:   SOURCE_DATE_EPOCH  fixed mtime for reproducible archives (default: last commit time)
set -euo pipefail

version="${1:?usage: package.sh <version>}"
dist=dist
epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || date +%s)}"
command -v zip >/dev/null || { echo "package: zip not installed" >&2; exit 1; }

rm -f "$dist"/helmscope_*.tar.gz "$dist"/helmscope_*.zip "$dist"/SHA256SUMS

stage() { # <platform> <binary name> -> prints staging dir
  local plat="$1" bin="$2" dir="$dist/stage/helmscope_${version}_$1"
  [[ -f "$dist/bin/$plat/$bin" ]] || { echo "package: missing $dist/bin/$plat/$bin (run make binaries)" >&2; exit 1; }
  rm -rf "$dir"; mkdir -p "$dir"
  cp "$dist/bin/$plat/$bin" README.md "$dir/"
  [[ -f LICENSE ]] && cp LICENSE "$dir/"
  find "$dir" -exec touch -h -d "@$epoch" {} +
  echo "$dir"
}

for plat in linux_amd64 darwin_universal; do
  dir="$(stage "$plat" helmscope)"
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" \
    -C "$(dirname "$dir")" -cf - "$(basename "$dir")" | gzip -n -9 > "$dist/$(basename "$dir").tar.gz"
done

dir="$(stage windows_amd64 helmscope.exe)"
(cd "$(dirname "$dir")" && find "$(basename "$dir")" -type f | LC_ALL=C sort | zip -q -X -9 "../$(basename "$dir").zip" -@)

rm -rf "$dist/stage"
(cd "$dist" && sha256sum helmscope_*.tar.gz helmscope_*.zip bin/*/helmscope* > SHA256SUMS)
echo "package: $dist/"
for f in "$dist"/helmscope_* "$dist"/SHA256SUMS; do printf '  %10s  %s\n' "$(wc -c < "$f")" "${f#"$dist"/}"; done
