#!/usr/bin/env bash
# Builds rsrc_windows_<arch>.syso so the Go linker embeds a VERSIONINFO block,
# an application manifest and an icon into helmscope.exe.
#
# An unsigned .exe with no publisher, version or description scores badly
# with AV/EDR heuristics; this metadata is one of the cheapest fixes.
#
# usage: scripts/winres.sh <version> [arch]     (run from the repo root)
# env:   WINDRES          windres binary (default x86_64-w64-mingw32-windres)
#        WIN_COMPANY      CompanyName (match your signing certificate's O=)
#        WIN_COPYRIGHT    LegalCopyright
#        REQUIRE_WINRES=1 fail instead of skipping when windres is missing
set -euo pipefail

version="${1:?usage: winres.sh <version> [arch]}"
arch="${2:-amd64}"
case "$arch" in
  amd64) target=pe-x86-64; procarch=amd64; default_windres=x86_64-w64-mingw32-windres ;;
  arm64) target=pe-aarch64-little; procarch=arm64; default_windres=aarch64-w64-mingw32-windres ;;
  *) echo "winres: unsupported arch $arch" >&2; exit 2 ;;
esac
windres="${WINDRES:-$default_windres}"
out="rsrc_windows_${arch}.syso"
rm -f "$out"

if ! command -v "$windres" >/dev/null 2>&1; then
  if [[ "${REQUIRE_WINRES:-0}" == 1 ]]; then
    echo "winres: $windres not found (apt install binutils-mingw-w64-x86-64)" >&2
    exit 1
  fi
  echo "winres: WARNING $windres not found; helmscope.exe will have no version info or manifest" >&2
  exit 0
fi

# v1.2.3-rc.1 -> 1,2,3,0 ; anything else -> 0,0,0,0
if [[ "$version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  nums="${BASH_REMATCH[1]},${BASH_REMATCH[2]},${BASH_REMATCH[3]},0"
else
  nums="0,0,0,0"
fi
dotted="${nums//,/.}"
company="${WIN_COMPANY:-helmscope}"
copyright="${WIN_COPYRIGHT:-Copyright (c) $(date -u +%Y) ${company}}"
esc() { printf '%s' "$1" | sed 's/"/""/g'; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
here="$(cd "$(dirname "$0")/.." && pwd)"

sed -e "s/@VERSION@/${dotted}/" -e "s/@ARCH@/${procarch}/" \
  "$here/build/windows/helmscope.exe.manifest" > "$work/helmscope.exe.manifest"
cp "$here/build/windows/helmscope.ico" "$work/helmscope.ico"

# Numeric resource types keep this free of the mingw headers:
# 24 = RT_MANIFEST (id 1 = process manifest), 16 = RT_VERSION.
cat > "$work/helmscope.rc" <<RC
1 24 "helmscope.exe.manifest"
1 ICON "helmscope.ico"
1 VERSIONINFO
FILEVERSION ${nums}
PRODUCTVERSION ${nums}
FILEFLAGSMASK 0x3f
FILEFLAGS 0x0
FILEOS 0x40004
FILETYPE 0x1
FILESUBTYPE 0x0
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "$(esc "$company")"
      VALUE "FileDescription", "helmscope - local, read-only Helm template viewer"
      VALUE "FileVersion", "${dotted}"
      VALUE "InternalName", "helmscope"
      VALUE "LegalCopyright", "$(esc "$copyright")"
      VALUE "OriginalFilename", "helmscope.exe"
      VALUE "ProductName", "helmscope"
      VALUE "ProductVersion", "$(esc "$version")"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
RC

# windres pipes .rc files through the C preprocessor (mingw gcc) by default.
# This file has no #include/#define, so a pass-through avoids needing gcc.
# shellcheck disable=SC2016 # $a/$f belong to the generated script
printf '#!/bin/sh\nfor a; do f="$a"; done\nexec cat "$f"\n' > "$work/cpp-passthrough"
chmod +x "$work/cpp-passthrough"
(cd "$work" && "$windres" --preprocessor="$work/cpp-passthrough" --target="$target" -O coff -i helmscope.rc -o resource.syso)
mv "$work/resource.syso" "$out"
echo "winres: wrote $out (version ${dotted}, company ${company})"
