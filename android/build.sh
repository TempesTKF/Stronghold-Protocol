#!/usr/bin/env bash
# 构建 Android 外壳的 debug APK（把这个仓库的浏览器客户端装进 WebView）。
#
#   bash android/build.sh
#
# 不依赖 Gradle / Android Studio：aapt2 编译资源 → javac → d8 → jar 打包 → zipalign → apksigner。
# 需要 JDK 17+ 与 Android SDK 的 build-tools、platform（版本见 android/README.md）。
# 产物：android/build/stronghold-shell-debug.apk（版本号跟随 shared/constants.js 的 APP_VERSION）
#
# 可选内容（本地模式，默认不打进包；在位时自动加入）：
#   android/runtimes/<abi>/lib*.so          面向 Android 的 node 可执行文件（必须叫 lib*.so）
#   android/app/src/main/assets/game/…      游戏文件（server/ public/ data/ shared/ packs/ node_modules/ws）

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
# Git Bash 需要 Windows 形式路径喂给原生工具；macOS / Linux 原样返回。
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
HERE_WIN="$(win "$HERE")"
OUT="${OUT_DIR:-$HERE/build}"
OUT_WIN="$(win "$OUT")"

# ---- 工具链探测（Git Bash 会补 .exe；macOS / Linux 走同名可执行文件）----
find_existing() {
  local candidate
  for candidate in "$@"; do
    [ -n "$candidate" ] || continue
    candidate="${candidate//\\//}"
    [ -e "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

SDK_WIN="$(find_existing "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" \
  "${LOCALAPPDATA:-}/Android/Sdk" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk")" \
  || { echo "找不到 Android SDK：设 ANDROID_SDK_ROOT 指向 SDK 目录（内含 build-tools/ 与 platforms/）" >&2; exit 1; }

# JAVA_HOME 可能是残留变量（指向已卸载的 JDK），必须实测 bin/javac 是否存在。
JAVA_HOME_SANE=""
if [ -n "${JAVA_HOME:-}" ] && { [ -e "${JAVA_HOME//\\//}/bin/javac" ] || [ -e "${JAVA_HOME//\\//}/bin/javac.exe" ]; }; then
  JAVA_HOME_SANE="$JAVA_HOME"
fi
JDK_WIN="$(find_existing "${JDK_HOME:-}" "$JAVA_HOME_SANE" \
  "${LOCALAPPDATA:-}/Programs/Android Studio/jbr" "${PROGRAMFILES:-}/Android/Android Studio/jbr")" \
  || { echo "找不到 JDK：设 JDK_HOME 指向含 bin/javac 的目录，或安装 Android Studio 使用其自带 JBR" >&2; exit 1; }

BT_VERSION="${BT_VERSION:-36.0.0}"
PLATFORM="${PLATFORM:-android-36}"
BT="$SDK_WIN/build-tools/$BT_VERSION"
PLATFORM_JAR="$SDK_WIN/platforms/$PLATFORM/android.jar"

# ---- 版本号跟随仓库（APP_VERSION，形如 0.2.6 或 0.2.6-dev）----
VERSION_NAME="$(sed -nE "s/^export const APP_VERSION = '([^']+)';.*/\1/p" "$REPO/shared/constants.js" | head -1)"
[ -n "$VERSION_NAME" ] || VERSION_NAME="0.0.0"
VERSION_CODE="$(printf '%s' "$VERSION_NAME" | sed -E 's/^([0-9]+)\.([0-9]+)\.([0-9]+).*/\1*10000 + \2*100 + \3/;t;s/.*/0/')"
VERSION_CODE=$(( VERSION_CODE ))

MIN_SDK=26
TARGET_SDK=36

need() { [ -e "$1" ] || { echo "缺少工具或文件：$1" >&2; exit 1; }; }
need "$JDK_WIN/bin/javac"; need "$JDK_WIN/bin/java"; need "$JDK_WIN/bin/keytool"; need "$JDK_WIN/bin/jar"
need "$BT/aapt2"; need "$BT/zipalign"; need "$BT/lib/d8.jar"; need "$BT/lib/apksigner.jar"
need "$PLATFORM_JAR"; need "$BT/core-lambda-stubs.jar"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "[1/6] aapt2 compile resources"
"$BT/aapt2" compile --dir "$HERE_WIN/app/src/main/res" -o "$OUT_WIN/res.zip"

echo "[2/6] aapt2 link（版本 $VERSION_NAME / $VERSION_CODE）"
ASSETS=()
[ -d "$HERE/app/src/main/assets" ] && ASSETS=(--assets "$HERE_WIN/app/src/main/assets")
"$BT/aapt2" link \
  -o "$OUT_WIN/base.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$HERE_WIN/app/src/main/AndroidManifest.xml" \
  "${ASSETS[@]}" \
  --java "$OUT_WIN/gen" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  "$OUT_WIN/res.zip"

echo "[3/6] javac"
find "$HERE/app/src/main/java" "$OUT/gen" -name '*.java' | while IFS= read -r file; do printf '%s\n' "$(win "$file")"; done > "$OUT/sources.txt"
# lambda 脱糖需要 core-lambda-stubs.jar：android.jar 里没有 java.lang.invoke.LambdaMetafactory（AGP 同样这么做）
"$JDK_WIN/bin/javac" -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$PLATFORM_JAR;$BT/core-lambda-stubs.jar" -classpath "$PLATFORM_JAR" \
  -nowarn -Xlint:-options \
  -d "$OUT_WIN/classes" "@$OUT_WIN/sources.txt"

echo "[4/6] d8 -> classes.dex"
find "$OUT/classes" -name '*.class' | while IFS= read -r file; do printf '%s\n' "$(win "$file")"; done > "$OUT/classes.txt"
"$JDK_WIN/bin/java" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --min-api "$MIN_SDK" --lib "$PLATFORM_JAR" --release \
  --output "$OUT_WIN/dex" "@$OUT_WIN/classes.txt"

echo "[5/6] pack + zipalign"
# classes.dex 用 JDK 自带的 jar 写入（DEFLATE，与 aapt2 产出的条目共存，不额外依赖 Python）
( cd "$OUT/dex" && "$JDK_WIN/bin/jar" --update --file "$OUT_WIN/base.apk" classes.dex )
# 可选的原生库（本地模式）：先摆成 lib/<abi>/ 结构，再以不压缩方式加入
if [ -d "$HERE/runtimes" ] && [ -n "$(find "$HERE/runtimes" -name '*.so' -print -quit 2>/dev/null)" ]; then
  rm -rf "$OUT/stage"
  for abi_dir in "$HERE"/runtimes/*/; do
    [ -d "$abi_dir" ] || continue
    abi="$(basename "$abi_dir")"
    mkdir -p "$OUT/stage/lib/$abi"
    cp "$abi_dir"*.so "$OUT/stage/lib/$abi/" 2>/dev/null || true
  done
  ( cd "$OUT/stage" && "$JDK_WIN/bin/jar" --update -0 --file "$OUT_WIN/base.apk" lib )
  echo "    已加入原生库：$(cd "$OUT/stage" && find lib -name '*.so' | tr '\n' ' ')"
fi
"$BT/zipalign" -p -f 4 "$OUT_WIN/base.apk" "$OUT_WIN/aligned.apk"

echo "[6/6] sign"
# 用 Android 标准的调试 keystore 位置（与 Android Studio 一致），放仓库外，且换机器也能覆盖安装。
KEYSTORE_DIR="${ANDROID_DEBUG_KEYSTORE_DIR:-$HOME/.android}"
KEYSTORE="$KEYSTORE_DIR/debug.keystore"
mkdir -p "$KEYSTORE_DIR"
if [ ! -f "$KEYSTORE" ]; then
  "$JDK_WIN/bin/keytool" -genkeypair -keystore "$(win "$KEYSTORE")" \
    -storepass android -keypass android -alias androiddebugkey \
    -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
fi
"$JDK_WIN/bin/java" -jar "$BT/lib/apksigner.jar" sign \
  --ks "$(win "$KEYSTORE")" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$OUT_WIN/stronghold-shell-debug.apk" "$OUT_WIN/aligned.apk"

echo ""
echo "== artifact =="
ls -la "$OUT/stronghold-shell-debug.apk"
"$JDK_WIN/bin/java" -jar "$BT/lib/apksigner.jar" verify --print-certs \
  "$OUT_WIN/stronghold-shell-debug.apk" | head -6
"$BT/aapt2" dump badging "$OUT_WIN/stronghold-shell-debug.apk" | head -8
