#!/bin/bash
# Install the pinned upstream Rust compiler inside this project only.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
rust_version=1.95.0
rust_target=aarch64-apple-darwin
toolchain_root="$project_root/build/hooks-toolchain/$rust_version"
archive_root="$project_root/build/hooks-toolchain/downloads"
[ "$(uname -m)" = arm64 ] || { echo 'This helper build currently targets Apple Silicon.' >&2; exit 1; }
mkdir -p "$archive_root" "$toolchain_root"
for component in rustc rust-std cargo; do
  archive="$component-$rust_version-$rust_target.tar.xz"
  archive_path="$archive_root/$archive"
  curl --fail --silent --show-error --location --max-time 30 "https://static.rust-lang.org/dist/$archive.sha256" -o "$archive_path.sha256"
  if ! (cd "$archive_root" && shasum -a 256 -c "$archive.sha256") >/dev/null 2>&1; then
    curl --fail --show-error --location --retry 2 --max-time 600 "https://static.rust-lang.org/dist/$archive" -o "$archive_path"
  fi
  (cd "$archive_root" && shasum -a 256 -c "$archive.sha256")
  tar -xJf "$archive_path" -C "$archive_root"
  bash "$archive_root/${archive%.tar.xz}/install.sh" --prefix="$toolchain_root" --disable-ldconfig
 done
"$toolchain_root/bin/rustc" --version
"$toolchain_root/bin/cargo" --version
