#!/usr/bin/env bash
# 为离线版准备运行时：从 Termux 镜像取 Node（nodejs-lts）与它真正引用的依赖库，
# 解出可执行文件与 .so，放进 android/runtimes/<abi>/。
#
#   bash android/tools/stage-runtime.sh              # 默认 arm64-v8a 与 x86_64
#   bash android/tools/stage-runtime.sh arm64-v8a    # 只要手机用的
#
# 这些文件不进 git（见 android/.gitignore）；android/build.sh --offline 会把它们打进
# APK 的 lib/<abi>/。文件名必须是 lib*.so*：APK 的 lib/<abi>/ 只解压这类名字，
# 而且 Android 10+ 只允许从 nativeLibraryDir 执行二进制。
#
# 需要的库由扫描 node 与各库的 DT_NEEDED 得出（libc / libdl / libm 由 Android 提供，不打）：
#   node → libc++_shared.so libcares.so libcrypto.so.3 libicui18n.so.78 libicuuc.so.78
#          libsqlite3.so libssl.so.3 libz.so.1
#   libicuuc.so.78 → libicudata.so.78
# 实测（Android 16 x86_64 模拟器）：node v24.18.0 与 server/index.js 都能正常跑。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # android/tools
ANDROID_DIR="$(cd "$HERE/.." && pwd)"          # android
MIRRORS=(
  "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main"
  "https://packages.termux.dev/apt/termux-main"
)
PACKAGES=(nodejs-lts libc++ libicu openssl c-ares zlib libsqlite)

WORK="${TMPDIR:-/tmp}/sp-stage-runtime"
mkdir -p "$WORK"

abi_to_arch() {
  case "$1" in
    arm64-v8a) echo aarch64 ;;
    armeabi-v7a) echo arm ;;
    x86_64) echo x86_64 ;;
    x86) echo i686 ;;
    *) echo "未知 ABI：$1" >&2; return 1 ;;
  esac
}

# 从 .deb（ar 归档）里取出 data.tar.* 成员写到 $2（没有 ar 工具，手工按 60 字节头解析）
deb_data() {
  local deb="$1" out="$2" size total off hdr name
  total=$(stat -c%s "$deb")
  off=8
  while [ "$off" -lt "$total" ]; do
    hdr=$(dd if="$deb" bs=1 skip="$off" count=60 2>/dev/null | tr -d '\0')
    name=$(printf '%s' "${hdr:0:16}" | tr -d ' ')
    size=$(printf '%s' "${hdr:48:10}" | tr -d ' ')
    case "$size" in ''|*[!0-9]*) return 1 ;; esac
    if [ "${name#data.tar}" != "$name" ]; then
      tail -c "+$((off + 61))" "$deb" | head -c "$size" > "$out"
      return 0
    fi
    off=$((off + 60 + size + (size % 2)))
  done
  return 1
}

# 取某个包 xxx.deb 的下载 URL：读 apt 索引里的 Filename 字段（版本号带修订号，不能自己拼）
package_url() {
  local mirror="$1" index="$2" pkg="$3" fn
  fn=$(awk -v want="$pkg" '
    $0 == "Package: " want { inblock = 1; next }
    inblock && /^Filename:/ { print $2; exit }
    inblock && /^$/ { inblock = 0 }
  ' "$index")
  [ -n "$fn" ] || return 1
  printf '%s/%s' "$mirror" "$fn"
}

fetch_index() {
  local arch="$1" out="$2" mirror
  for mirror in "${MIRRORS[@]}"; do
    if curl -sL --max-time 90 -o "$out.tmp" "$mirror/dists/stable/main/binary-$arch/Packages" && [ -s "$out.tmp" ]; then
      mv "$out.tmp" "$out"
      echo "$mirror"
      return 0
    fi
  done
  return 1
}

stage_abi() {
  local abi="$1" arch mirror index pkg url deb root
  arch="$(abi_to_arch "$abi")"
  local dest="$ANDROID_DIR/runtimes/$abi"
  echo "== $abi（Termux 的 $arch）→ runtimes/$abi"
  rm -rf "$dest" "$WORK/$arch"
  mkdir -p "$dest" "$WORK/$arch"

  index="$WORK/$arch/Packages"
  mirror="$(fetch_index "$arch" "$index")" || { echo "  取不到 apt 索引（镜像都不通）" >&2; return 1; }
  echo "  镜像：$mirror"

  local pkgdir="$WORK/$arch/pkgs"
  for pkg in "${PACKAGES[@]}"; do
    url="$(package_url "$mirror" "$index" "$pkg")" || { echo "  索引里没有 $pkg" >&2; return 1; }
    # 本地文件名要把 deb 版本里的冒号换掉（Windows 文件名不允许冒号）
    deb="$pkgdir/$(basename "$url" | tr ':' '_')"
    mkdir -p "$pkgdir"
    [ -s "$deb" ] || curl -sL --max-time 180 -o "$deb" "$url" || { echo "  下载失败：$url" >&2; return 1; }
    root="$WORK/$arch/x/$pkg"
    mkdir -p "$root"
    deb_data "$deb" "$WORK/$arch/data.tar.xz" || { echo "  $pkg 的 deb 解析失败" >&2; return 1; }
    # 只解出 bin/node 与 lib/*.so*：Termux 包里的文档软链在 Windows 上建不了（没有建符号链接的权限），
    # 而那些软链本来也不需要——真正的库文件会被解出来，pick 用 cp -L 按需要的名字复制。
    tar -xJf "$WORK/$arch/data.tar.xz" -C "$root" --wildcards '*/bin/node' '*/lib/*.so*' 2>"$WORK/$arch/tar.err" || true
    # 容忍两类无害报错：Windows 上建不了符号链接；某个包本来就没有 bin/ 或 lib/ 下的匹配项。
    # 真正缺文件会在下面 pick 时暴露。
    if grep -Ev "Cannot create symlink|Not found in archive|Exiting with failure status" "$WORK/$arch/tar.err" | grep -q .; then
      cat "$WORK/$arch/tar.err" >&2
      echo "  $pkg 解包出错" >&2
      return 1
    fi
  done

  # 只保留需要的文件（名字按 DT_NEEDED 里的 SONAME，实测可被 APK 正常解压）
  pick() { # pick 目标名 源包 候选名字…
    local name="$1" from="$2"; shift 2
    local root="$WORK/$arch/x/$from" hit
    for pattern in "$@"; do
      hit="$(find "$root" -name "$pattern" | head -1)"
      if [ -n "$hit" ]; then
        cp -Lf "$hit" "$dest/$name"
        printf '    %-22s %6s KB  <- %s\n' "$name" "$(( $(stat -c%s "$dest/$name") / 1024 ))" "${hit#"$root"/}"
        return 0
      fi
    done
    echo "    找不到 $name（候选：$*）" >&2
    return 1
  }

  pick libnode.so    nodejs-lts node
  pick libc++_shared.so libc++ 'libc++_shared.so*'
  pick libcares.so   c-ares 'libcares.so*'
  pick libcrypto.so.3 openssl 'libcrypto.so.3*'
  pick libssl.so.3   openssl 'libssl.so.3*'
  pick libicudata.so.78 libicu 'libicudata.so.78*'
  pick libicui18n.so.78 libicu 'libicui18n.so.78*'
  pick libicuuc.so.78 libicu 'libicuuc.so.78*'
  pick libsqlite3.so libsqlite 'libsqlite3.so*'
  pick libz.so.1     zlib 'libz.so.1*'

  chmod 755 "$dest/libnode.so"
  echo "  合计 $(du -sh "$dest" | cut -f1)（$(ls "$dest" | wc -l) 个文件）"
}

if [ "$#" -gt 0 ]; then
  for abi in "$@"; do stage_abi "$abi"; done
else
  for abi in arm64-v8a x86_64; do stage_abi "$abi"; done
fi

echo ""
echo "完成。构建离线版：MODE=offline bash android/build.sh（见 android/README.md）"
