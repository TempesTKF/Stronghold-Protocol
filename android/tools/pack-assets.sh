#!/usr/bin/env bash
# 把 public/assets 与 public/fonts 打成离线版在手机上导入的素材包：
#   android/build/stronghold-assets-<APP_VERSION>.zip，里面是 assets/… 与 fonts/…
# 放进手机后，在离线版首页「素材与皮肤 → 导入素材包 / 皮肤包」选它（ContentStore 解到 filesDir/content，
# 再链进游戏目录）。素材是官方美术，这个包只供个人使用，不要分发。
#
#   bash android/tools/pack-assets.sh
#
# 前置：仓库根跑过 npm run setup（或 node tools/fetch-assets.mjs），有 public/assets 与 public/fonts；
# 素材包要和 APK 出自同一版本（data/assets.json 随 APK，素材文件随包）。
# 不压缩（-0）：素材几乎都是 png / webp / mp3 / skel 这类已压缩格式，再 deflate 只费时间。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$ANDROID_DIR/.." && pwd)"
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

for dir in public/assets public/fonts; do
  [ -d "$REPO/$dir" ] || { echo "缺 $dir：先在仓库根跑 npm run setup" >&2; exit 1; }
done
JAR=""
for candidate in "${JDK_HOME:-}" "${JAVA_HOME:-}"; do
  [ -n "$candidate" ] || continue
  candidate="${candidate//\\//}"
  if [ -e "$candidate/bin/jar" ] || [ -e "$candidate/bin/jar.exe" ]; then JAR="$candidate/bin/jar"; break; fi
done
[ -n "$JAR" ] || { echo "找不到 jar：设 JDK_HOME 指向含 bin/jar 的 JDK" >&2; exit 1; }

VERSION="$(sed -nE "s/^export const APP_VERSION = '([^']+)';.*/\1/p" "$REPO/shared/constants.js" | head -1)"
OUT="$ANDROID_DIR/build/stronghold-assets-${VERSION:-0}.zip"
mkdir -p "$ANDROID_DIR/build"
rm -f "$OUT"
echo "打包中…（public/assets + public/fonts → $OUT）"
"$JAR" --create --no-manifest --no-compress --file "$(win "$OUT")" \
  -C "$(win "$REPO/public")" assets -C "$(win "$REPO/public")" fonts
echo "已生成 $OUT"
echo "  大小 $(du -h "$OUT" | cut -f1)，$(unzip -Z1 "$OUT" 2>/dev/null | grep -vc '/$' || echo '?') 个文件"
