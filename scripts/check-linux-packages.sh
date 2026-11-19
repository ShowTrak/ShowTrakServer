#!/usr/bin/env bash
# Checks the Linux packages `npm run make` left in out/: that they, and every
# binary in the app they were made from, are for the machine that built them,
# and that nothing in them needs a newer glibc than the oldest system they are
# meant to run on.
#
# The ARM64 packages are the Raspberry Pi builds. A native addon downloaded or
# compiled for the wrong machine (an x64 sqlite3 inside the arm64 .deb), or one
# linked against a newer glibc than Raspberry Pi OS has, is packaged without
# complaint and only fails when someone's Pi starts the app.
#
# Run by the release workflow after `npm run make` on each Linux runner; runs
# the same on any Linux machine with dpkg-deb, rpm and readelf.
set -uo pipefail
shopt -s nullglob

case "$(uname -m)" in
  x86_64)
    DEB_ARCH=amd64 RPM_ARCH=x86_64 ELF_MACHINE='X86-64'
    # The image the x64 packages are built on (see the release workflow).
    GLIBC_MAX=2.39 GLIBC_FOR='Ubuntu 24.04'
    ;;
  aarch64)
    DEB_ARCH=arm64 RPM_ARCH=aarch64 ELF_MACHINE='AArch64'
    GLIBC_MAX=2.36 GLIBC_FOR='Raspberry Pi OS 12 (Bookworm)'
    ;;
  *)
    echo "::error::No package check for a $(uname -m) machine."
    exit 1
    ;;
esac

FAILED=0
fail() {
  echo "::error::$1"
  FAILED=1
}

# Whether version $1 is no newer than $2.
version_le() {
  [ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$2" ]
}

DEBS=(out/make/deb/*/*.deb)
RPMS=(out/make/rpm/*/*.rpm)
[ "${#DEBS[@]}" -gt 0 ] || fail 'No .deb in out/make/deb.'
[ "${#RPMS[@]}" -gt 0 ] || fail 'No .rpm in out/make/rpm.'
for f in "${DEBS[@]}"; do
  arch=$(dpkg-deb -f "$f" Architecture)
  echo "$f: $arch"
  [ "$arch" = "$DEB_ARCH" ] || fail "$f is for $arch, not $DEB_ARCH."
done
for f in "${RPMS[@]}"; do
  arch=$(rpm -qp --qf '%{ARCH}' "$f" 2>/dev/null)
  echo "$f: $arch"
  [ "$arch" = "$RPM_ARCH" ] || fail "$f is for ${arch:-an unreadable architecture}, not $RPM_ARCH."
done

# The packaged app the makers wrapped: Electron, its libraries, and the native
# addons unpacked beside the asar.
APPS=(out/*-linux-*/)
if [ "${#APPS[@]}" -ne 1 ]; then
  fail "Expected one packaged Linux app in out/, found ${#APPS[@]}."
  exit 1
fi

BINARIES=0
NEWEST_GLIBC=0
while IFS= read -r -d '' f; do
  header=$(readelf -h "$f" 2>/dev/null) || continue # not an ELF file
  BINARIES=$((BINARIES + 1))
  machine=$(sed -n 's/^ *Machine: *//p' <<<"$header")
  case "$machine" in
    *"$ELF_MACHINE"*) ;;
    *) fail "${f#"${APPS[0]}"} is for $machine, not $ELF_MACHINE." ;;
  esac
  glibc=$(readelf -V -W "$f" 2>/dev/null | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -uV | tail -n 1)
  case "$f" in
    *.node) echo "Native addon ${f#"${APPS[0]}"}: $machine, glibc ${glibc:-any}" ;;
  esac
  [ -n "$glibc" ] || continue
  version_le "$glibc" "$GLIBC_MAX" ||
    fail "${f#"${APPS[0]}"} needs glibc $glibc; $GLIBC_FOR has $GLIBC_MAX."
  version_le "$glibc" "$NEWEST_GLIBC" || NEWEST_GLIBC=$glibc
done < <(find "${APPS[0]}" -type f -print0)

[ "$BINARIES" -gt 0 ] || fail "No ELF binaries found in ${APPS[0]}."
echo "Checked $BINARIES binaries in ${APPS[0]}: newest glibc needed $NEWEST_GLIBC (limit $GLIBC_MAX, $GLIBC_FOR)."
exit "$FAILED"
