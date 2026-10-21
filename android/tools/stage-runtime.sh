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
#
# 校验（下载的东西会以可执行文件的身份装进 APK，所以每一层都核对，任一处不符即中止）：
#   1. apt 索引 Packages 的 SHA256 必须等于同一镜像 dists/stable/InRelease 里列的值；
#      装了 gpgv 且设了 TERMUX_KEYRING（Termux 仓库公钥的 keyring 文件）时，再验 InRelease 的签名，
#      否则信任链只锚定在 HTTPS 上（脚本会提示）。
#   2. 每个 .deb 的 SHA256 必须等于索引里该包的 SHA256 字段。
#   3. 锁文件 android/tools/termux-runtime.lock 存在时，每个 .deb 的文件名与 SHA256 还必须与它一致
#      （钉住版本：镜像换了包就停下来，而不是悄悄换运行时）。--write-lock 按本次下载的结果重写它。
#   4. 解包前列出 data.tar 的成员：绝对路径、含 .. 的路径一律拒绝；挑文件时解析软链后的真实路径
#      必须仍在该包的解包目录里；挑出的文件必须是 ELF。
#
#   bash android/tools/stage-runtime.sh --write-lock arm64-v8a   # 首次（或有意升级运行时）时写锁文件

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # android/tools
ANDROID_DIR="$(cd "$HERE/.." && pwd)"          # android
LOCK_FILE="$HERE/termux-runtime.lock"
WRITE_LOCK=0
CURL=(curl -fsSL --proto '=https' --tlsv1.2)
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

sha256() { sha256sum "$1" | cut -d' ' -f1; }

# 读 apt 索引里某个包的 Filename 与 SHA256（版本号带修订号，不能自己拼）→ 打印「Filename SHA256」
package_entry() {
  local index="$1" pkg="$2"
  awk -v want="$pkg" '
    $0 == "Package: " want { inblock = 1; fn = ""; sum = ""; next }
    inblock && /^Filename:/ { fn = $2 }
    inblock && /^SHA256:/ { sum = $2 }
    inblock && /^$/ { if (fn != "" && sum != "") { print fn, sum; exit } inblock = 0 }
    END { if (inblock && fn != "" && sum != "") print fn, sum }
  ' "$index" | head -1
}

# 锁文件里的一行：「arch 包名 Filename SHA256」
lock_entry() {
  [ -f "$LOCK_FILE" ] || return 1
  awk -v a="$1" -v p="$2" '$1 == a && $2 == p { print $3, $4; found = 1; exit } END { exit !found }' "$LOCK_FILE"
}

# 取 InRelease 与 Packages，核对 Packages 的哈希（与可选的签名）；成功时打印所用镜像
fetch_index() {
  local arch="$1" out="$2" mirror want got
  for mirror in "${MIRRORS[@]}"; do
    rm -f "$out.release" "$out.tmp"
    "${CURL[@]}" --max-time 60 -o "$out.release" "$mirror/dists/stable/InRelease" || continue
    "${CURL[@]}" --max-time 90 -o "$out.tmp" "$mirror/dists/stable/main/binary-$arch/Packages" || continue
    [ -s "$out.tmp" ] || continue
    if [ -n "${TERMUX_KEYRING:-}" ]; then
      command -v gpgv >/dev/null 2>&1 || { echo "  设了 TERMUX_KEYRING 但找不到 gpgv" >&2; return 1; }
      gpgv --keyring "$TERMUX_KEYRING" "$out.release" >/dev/null 2>&1 \
        || { echo "  $mirror 的 InRelease 签名校验失败" >&2; continue; }
    fi
    # InRelease 的 SHA256: 段里形如「 <hash> <size> main/binary-<arch>/Packages」
    want="$(awk -v f="main/binary-$arch/Packages" '
      /^SHA256:/ { s = 1; next } /^[^ ]/ { s = 0 }
      s && $3 == f { print $1; exit }' "$out.release")"
    got="$(sha256 "$out.tmp")"
    if [ -z "$want" ] || [ "$want" != "$got" ]; then
      echo "  $mirror 的 Packages 与 InRelease 对不上（期望 ${want:-无}，实际 $got），换下一个镜像" >&2
      continue
    fi
    mv "$out.tmp" "$out"
    echo "$mirror"
    return 0
  done
  return 1
}

# 列出 data.tar 的成员，拒绝绝对路径与含 .. 的路径（解包前做，不依赖 tar 自己的默认行为）
check_members() {
  local tarball="$1" bad
  bad="$(tar -tJf "$tarball" | grep -E '^/|(^|/)\.\.(/|$)' | head -3 || true)"
  [ -z "$bad" ] || { echo "  归档里有跳出目标目录的路径：$bad" >&2; return 1; }
}

stage_abi() {
  local abi="$1" arch mirror index pkg url deb root entry fn sum locked got
  arch="$(abi_to_arch "$abi")"
  local dest="$ANDROID_DIR/runtimes/$abi"
  echo "== $abi（Termux 的 $arch）→ runtimes/$abi"
  rm -rf "$dest" "$WORK/$arch/x"
  mkdir -p "$dest" "$WORK/$arch"

  index="$WORK/$arch/Packages"
  mirror="$(fetch_index "$arch" "$index")" || { echo "  取不到可信的 apt 索引（镜像都不通或校验失败）" >&2; return 1; }
  local signed="未验 InRelease 签名（设 TERMUX_KEYRING 可加验）"
  [ -z "${TERMUX_KEYRING:-}" ] || signed="InRelease 签名已验"
  echo "  镜像：$mirror（Packages 已与 InRelease 核对；$signed）"

  local pkgdir="$WORK/$arch/pkgs"
  mkdir -p "$pkgdir"
  for pkg in "${PACKAGES[@]}"; do
    entry="$(package_entry "$index" "$pkg")"
    [ -n "$entry" ] || { echo "  索引里没有 $pkg" >&2; return 1; }
    fn="${entry% *}"; sum="${entry#* }"
    case "$fn" in /*|*..*) echo "  索引里 $pkg 的 Filename 可疑：$fn" >&2; return 1 ;; esac
    if [ "$WRITE_LOCK" = 0 ] && locked="$(lock_entry "$arch" "$pkg")"; then
      if [ "$locked" != "$fn $sum" ]; then
        echo "  $pkg 与锁文件不符：锁定 ${locked}，镜像现为 $fn $sum" >&2
        echo "  （镜像升级了包；确认要换运行时就加 --write-lock 重跑，并重新实测）" >&2
        return 1
      fi
    fi
    url="$mirror/$fn"
    # 本地文件名要把 deb 版本里的冒号换掉（Windows 文件名不允许冒号）
    deb="$pkgdir/$(basename "$fn" | tr ':' '_')"
    [ -s "$deb" ] || "${CURL[@]}" --max-time 180 -o "$deb" "$url" || { rm -f "$deb"; echo "  下载失败：$url" >&2; return 1; }
    got="$(sha256 "$deb")"
    if [ "$got" != "$sum" ]; then
      rm -f "$deb"
      echo "  $pkg 的 SHA256 不符（期望 $sum，实际 $got），已删除" >&2
      return 1
    fi
    printf '    %-12s sha256 ok  %s\n' "$pkg" "$(basename "$fn")"
    [ "$WRITE_LOCK" = 0 ] || printf '%s %s %s %s\n' "$arch" "$pkg" "$fn" "$sum" >> "$LOCK_FILE.new"
    root="$WORK/$arch/x/$pkg"
    mkdir -p "$root"
    deb_data "$deb" "$WORK/$arch/data.tar.xz" || { echo "  $pkg 的 deb 解析失败" >&2; return 1; }
    check_members "$WORK/$arch/data.tar.xz" || return 1
    # 只解出 bin/node 与 lib/*.so*：Termux 包里的文档软链在 Windows 上建不了（没有建符号链接的权限），
    # 而那些软链本来也不需要——真正的库文件会被解出来，pick 用 cp -L 按需要的名字复制。
    tar -xJf "$WORK/$arch/data.tar.xz" -C "$root" --no-same-owner --no-same-permissions \
      --wildcards '*/bin/node' '*/lib/*.so*' 2>"$WORK/$arch/tar.err" || true
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
    local root="$WORK/$arch/x/$from" hit real base
    base="$(realpath "$root")"
    for pattern in "$@"; do
      hit="$(find "$root" -name "$pattern" | head -1)"
      if [ -n "$hit" ]; then
        # 软链解析后必须仍在本包的解包目录里，否则 cp -L 会把宿主机上的文件抄进 APK
        real="$(realpath "$hit")"
        case "$real" in "$base"/*) ;; *) echo "    $name 指向解包目录之外：$real" >&2; return 1 ;; esac
        [ "$(head -c 4 "$real" | od -An -tx1 | tr -d ' \n')" = 7f454c46 ] \
          || { echo "    $name 不是 ELF 文件：${hit#"$root"/}" >&2; return 1; }
        cp -f "$real" "$dest/$name"
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

if [ "${1:-}" = "--write-lock" ]; then WRITE_LOCK=1; shift; rm -f "$LOCK_FILE.new"; fi
ABIS=("$@")
[ "${#ABIS[@]}" -gt 0 ] || ABIS=(arm64-v8a x86_64)
for abi in "${ABIS[@]}"; do stage_abi "$abi"; done
if [ "$WRITE_LOCK" = 1 ]; then
  # 只替换本次处理过的 arch 的行，其余 arch 的锁保留
  {
    if [ -f "$LOCK_FILE" ]; then
      grep -v '^#' "$LOCK_FILE" | awk -v done="$(for abi in "${ABIS[@]}"; do abi_to_arch "$abi"; done | tr '\n' ' ')" '
        BEGIN { n = split(done, a, " "); for (i = 1; i <= n; i++) skip[a[i]] = 1 } !($1 in skip)'
    fi
    cat "$LOCK_FILE.new"
  } | sort > "$LOCK_FILE.tmp"
  { echo "# android/tools/stage-runtime.sh 的锁文件：arch 包名 Filename SHA256（--write-lock 生成）"; cat "$LOCK_FILE.tmp"; } > "$LOCK_FILE"
  rm -f "$LOCK_FILE.new" "$LOCK_FILE.tmp"
  echo "已写锁文件 $LOCK_FILE"
elif [ ! -f "$LOCK_FILE" ]; then
  echo "提示：还没有锁文件，本次只做了索引与哈希校验。确认运行时可用后可加 --write-lock 钉住版本。"
fi

echo ""
echo "完成。构建离线版：MODE=offline bash android/build.sh（见 android/README.md）"
