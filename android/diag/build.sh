#!/usr/bin/env bash
# 构建「卫戍协议诊断」小工具（android/diag，包名 app.stronghold.diag，约 20KB）：
# 离线版报「本机服务器启动失败」时给玩家装的独立 App，只读离线版的安装包，不改动它（见 DiagActivity）。
#
#   bash android/diag/build.sh        # → android/build/diag/stronghold-diag-debug.apk
#
# 流水线与 android/build.sh 相同（aapt2 link → javac → d8 → jar → zipalign → apksigner），没有资源文件；
# JDK / SDK 的探测从简：JDK_HOME（或 JAVA_HOME）与 ANDROID_SDK_ROOT（或 ANDROID_HOME、%LOCALAPPDATA%\Android\Sdk）。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
OUT="$HERE/../build/diag"
OUT_WIN="$(win "$OUT")"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${LOCALAPPDATA:-$HOME}/Android/Sdk}}"
JDK="${JDK_HOME:-${JAVA_HOME:-}}"
[ -d "${SDK//\\//}" ] || { echo "找不到 Android SDK：设 ANDROID_SDK_ROOT" >&2; exit 1; }
[ -n "$JDK" ] && [ -d "${JDK//\\//}" ] || { echo "找不到 JDK：设 JDK_HOME" >&2; exit 1; }
SDK="$(win "${SDK//\\//}")"
JDK="$(win "${JDK//\\//}")"
BT="$SDK/build-tools/${BT_VERSION:-36.0.0}"
PLATFORM_JAR="$SDK/platforms/${PLATFORM:-android-36}/android.jar"
MIN_SDK=26

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

echo "[1/5] aapt2 link"
"$BT/aapt2" link -o "$OUT_WIN/base.apk" -I "$PLATFORM_JAR" \
  --manifest "$(win "$HERE/AndroidManifest.xml")" -A "$(win "$HERE/assets")" \
  --min-sdk-version "$MIN_SDK" --target-sdk-version 36 \
  --version-code 3 --version-name 1.2

echo "[2/5] javac"
find "$HERE/java" -name '*.java' | while IFS= read -r file; do printf '"%s"\n' "$(win "$file")"; done > "$OUT/sources.txt"
"$JDK/bin/javac" -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$PLATFORM_JAR;$BT/core-lambda-stubs.jar" -classpath "$PLATFORM_JAR" \
  -nowarn -Xlint:-options -d "$OUT_WIN/classes" "@$OUT_WIN/sources.txt"

echo "[3/5] d8"
find "$OUT/classes" -name '*.class' | while IFS= read -r file; do printf '%s\n' "$(win "$file")"; done > "$OUT/classes.txt"
"$JDK/bin/java" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --min-api "$MIN_SDK" --lib "$PLATFORM_JAR" --release --output "$OUT_WIN/dex" "@$OUT_WIN/classes.txt"

echo "[4/5] pack + zipalign"
( cd "$OUT/dex" && "$JDK/bin/jar" --update --file "$OUT_WIN/base.apk" classes.dex )
"$BT/zipalign" -p -f 4 "$OUT_WIN/base.apk" "$OUT_WIN/aligned.apk"

echo "[5/5] sign"
# 与游戏同一把调试 keystore（android/build.sh 不存在时会生成）
KEYSTORE="${ANDROID_DEBUG_KEYSTORE_DIR:-$HOME/.android}/debug.keystore"
[ -f "$KEYSTORE" ] || { echo "缺调试 keystore：先跑一次 bash android/build.sh" >&2; exit 1; }
"$JDK/bin/java" -jar "$BT/lib/apksigner.jar" sign \
  --ks "$(win "$KEYSTORE")" --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey \
  --out "$OUT_WIN/stronghold-diag-debug.apk" "$OUT_WIN/aligned.apk"

ls -la "$OUT/stronghold-diag-debug.apk"
"$BT/aapt2" dump badging "$OUT_WIN/stronghold-diag-debug.apk" | head -3
