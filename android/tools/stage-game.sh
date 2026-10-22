#!/usr/bin/env bash
# 为离线版把游戏文件打包成 android/app/src/main/assets/game.zip（不进 git，见 android/.gitignore）。
# 构建时 aapt2 把它以不压缩的方式放进 APK，运行期 LocalRuntime 用 ZipInputStream 流式解压到 filesDir。
# 打成一个 zip 而不是目录树，是因为 Android 的 AssetManager.list() 数不出压缩的 assets，
# 而单个 zip 只要 open() 一个流就能读，解压也快得多。
#
#   bash android/tools/stage-game.sh                # 不含素材（约 9MB）：素材与皮肤在手机上单独导入（默认）
#   bash android/tools/stage-game.sh --with-assets  # 把 public/assets、public/fonts 也打进 APK（约 +720MB）
#   bash android/tools/stage-game.sh --assets-from <目录>  # 素材取自解开的上游完整发布包（含 3D 战场、官方特效）
#   bash android/tools/stage-game.sh --plugins <目录>   # 另外带上 <目录> 下的插件（可重复）
#
# --assets-from：<目录> 是解开的 Stronghold-Protocol-v<版本>.zip 的根（里面有 public/assets、public/fonts，
# 以及维护者本地提取素材的清单 data/local-assets.json、data/local-fx.json），版本要和本仓库一致
# （它的 data/assets.json 要与仓库里的相同，脚本会核对）。v0.3.1 约 1.2GB，APK 约 1.1GB。
#
# --plugins：<目录> 本身或它的每个子目录只要有 plugin.json，就按原名复制进游戏目录的 plugins/
# （服务器启动时自己扫描、校验；外观插件在 设置 → 插件 里由玩家自己打开）。
# 例：TKF v0.3.1 的皮肤素材包 official-operator-skins.zip 解开后有 4 个插件文件夹，把解开的目录传进来即可。
#
# 前置：仓库根跑过 npm install（要有服务端依赖与 public/vendor）；--with-assets 还要 npm run setup（public/assets、public/fonts）。
# 在手机上单独导入用的素材包由 android/tools/pack-assets.sh 生成。
#
# 收拢的是 server/index.js 运行时实际读到的全部（0.3.1 起比最初的清单多了 plugins / schemas / tools 与 ses、acorn）：
#   server shared data packs public package.json  服务端、共享代码、数据、语言包、浏览器客户端
#   plugins   插件目录（registry / policy 读它；仓库里只有说明与 _template，工作台引用其中的示例图）
#   schemas   server/plugins 读 schemas/dsl.schema.json
#   tools     server/plugins/pack.js 等直接 import tools/assets/*.mjs（约 1.6MB）
#   node_modules  只取服务端 import 的包（SERVER_DEPS）及其依赖，按 package-lock.json 求闭包

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$ANDROID_DIR/.." && pwd)"
ASSETS_DIR="$ANDROID_DIR/app/src/main/assets"
STAGE="$ANDROID_DIR/build/stage-game"
ZIP="$ASSETS_DIR/game.zip"

WITH_ASSETS=0
ASSETS_FROM=""
EXTRA_PLUGINS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-assets) WITH_ASSETS=1; shift ;;
    --no-assets) WITH_ASSETS=0; shift ;;   # 旧参数，现在就是默认
    --assets-from)
      [ -n "${2:-}" ] && [ -d "$2/public/assets" ] || { echo "--assets-from 要指向解开的完整发布包根目录（里面有 public/assets）" >&2; exit 1; }
      ASSETS_FROM="$(cd "$2" && pwd)"; WITH_ASSETS=1; shift 2 ;;
    --plugins)
      [ -n "${2:-}" ] && [ -d "$2" ] || { echo "--plugins 后面要跟一个存在的目录" >&2; exit 1; }
      if [ -f "$2/plugin.json" ]; then
        EXTRA_PLUGINS+=("$(cd "$2" && pwd)")
      else
        for dir in "$2"/*/; do
          [ -f "$dir/plugin.json" ] && EXTRA_PLUGINS+=("$(cd "$dir" && pwd)")
        done
      fi
      shift 2 ;;
    *) echo "未知参数：$1（可用 --with-assets、--plugins <目录>）" >&2; exit 1 ;;
  esac
done

ITEMS=(server shared data packs plugins schemas tools public package.json)
SERVER_DEPS=(ws ses acorn)

for item in "${ITEMS[@]}" package-lock.json public/vendor; do
  [ -e "$REPO/$item" ] || {
    echo "缺 $item：先在仓库根跑 npm install（与 npm run setup 下载素材）" >&2
    exit 1
  }
done
if [ "$WITH_ASSETS" = 1 ] && [ -z "$ASSETS_FROM" ] && [ ! -d "$REPO/public/assets" ]; then
  echo "缺 public/assets：先跑 npm run setup" >&2
  exit 1
fi
if [ -n "$ASSETS_FROM" ]; then
  # 素材按 data/assets.json 引用：发布包的清单与本仓库的不同，说明版本对不上
  cmp -s "$ASSETS_FROM/data/assets.json" "$REPO/data/assets.json" \
    || { echo "$ASSETS_FROM/data/assets.json 与仓库的 data/assets.json 不同：发布包版本和本仓库不一致" >&2; exit 1; }
fi
SRC_PUBLIC="${ASSETS_FROM:-$REPO}/public"

JAR=""
for candidate in "${JDK_HOME:-}" "${JAVA_HOME:-}" "C:/Tool/jdk21" \
    "${LOCALAPPDATA:-}/Programs/Android Studio/jbr" "${PROGRAMFILES:-}/Android/Android Studio/jbr"; do
  [ -n "$candidate" ] || continue
  candidate="${candidate//\\//}"
  if [ -e "$candidate/bin/jar" ] || [ -e "$candidate/bin/jar.exe" ]; then JAR="$candidate/bin/jar"; break; fi
done
[ -n "$JAR" ] || { echo "找不到 jar：设 JDK_HOME 指向含 bin/jar 的 JDK（或装 Android Studio 用其 JBR）" >&2; exit 1; }

# 服务端依赖的闭包：package-lock.json 的 packages 表（本仓库只有顶层 node_modules/<name>，没有嵌套安装）
LOCK="$REPO/package-lock.json"
if command -v cygpath >/dev/null 2>&1; then LOCK="$(cygpath -m "$LOCK")"; fi
DEPS="$(node -e '
  const lock = require(process.argv[1]);
  const todo = process.argv.slice(2), out = new Set();
  while (todo.length) {
    const name = todo.pop();
    if (out.has(name)) continue;
    const entry = lock.packages["node_modules/" + name];
    if (!entry) { console.error("package-lock.json 里没有 " + name); process.exit(1); }
    out.add(name);
    todo.push(...Object.keys(entry.dependencies || {}));
  }
  console.log([...out].sort().join(" "));
' "$LOCK" "${SERVER_DEPS[@]}")" || { echo "读不了 package-lock.json（需要 node）" >&2; exit 1; }
for dep in $DEPS; do
  [ -d "$REPO/node_modules/$dep" ] || { echo "缺 node_modules/$dep：先在仓库根跑 npm install" >&2; exit 1; }
done

rm -rf "$STAGE" "$ASSETS_DIR/game" "$ZIP"
mkdir -p "$STAGE/node_modules" "$ASSETS_DIR"
for item in "${ITEMS[@]}"; do
  if [ "$item" = public ]; then
    # 客户端代码取自本仓库；public/assets、public/fonts 不带素材时跳过（约 720MB），带素材时取自 SRC_PUBLIC
    mkdir -p "$STAGE/public"
    for child in "$REPO/public"/* "$REPO/public"/.[!.]*; do
      [ -e "$child" ] || continue
      case "$(basename "$child")" in assets|fonts) continue ;; esac
      cp -rL "$child" "$STAGE/public/"
    done
    if [ "$WITH_ASSETS" = 1 ]; then
      for art in assets fonts; do
        [ -d "$SRC_PUBLIC/$art" ] && cp -rL "$SRC_PUBLIC/$art" "$STAGE/public/$art"
      done
    fi
    continue
  fi
  cp -rL "$REPO/$item" "$STAGE/"
done
for dep in $DEPS; do
  mkdir -p "$STAGE/node_modules/$(dirname "$dep")"
  cp -rL "$REPO/node_modules/$dep" "$STAGE/node_modules/$dep"
done
echo "node_modules：$DEPS"
if [ -n "$ASSETS_FROM" ]; then
  # 维护者本地提取素材（public/assets/local/**）的清单；仓库里没有（gitignore），取自发布包
  for manifest in local-assets.json local-fx.json; do
    [ -f "$ASSETS_FROM/data/$manifest" ] && cp "$ASSETS_FROM/data/$manifest" "$STAGE/data/$manifest"
  done
  echo "素材：$ASSETS_FROM（$(du -sh "$STAGE/public/assets" | cut -f1)）"
fi
# 手机上的服务端入口：拉长房间与断线会话的保留窗口，切后台回来能接着打（见文件头）
cp "$HERE/offline-entry.mjs" "$STAGE/android-entry.mjs"
for dir in "${EXTRA_PLUGINS[@]+"${EXTRA_PLUGINS[@]}"}"; do
  name="$(basename "$dir")"
  case "$name" in _*|.*) echo "跳过插件目录 $name（以 _ 或 . 开头的目录服务器不加载）" >&2; continue ;; esac
  [ ! -e "$STAGE/plugins/$name" ] || { echo "插件 $name 与仓库 plugins/ 里的同名，停止" >&2; exit 1; }
  # 不跟随软链（-P）：插件目录里的软链不该把目录外的文件带进 APK
  cp -RP "$dir" "$STAGE/plugins/$name"
  if find "$STAGE/plugins/$name" -type l | grep -q .; then
    echo "插件 $name 里有软链，拒绝打包" >&2; exit 1
  fi
  echo "插件：$name（$(du -sh "$dir" | cut -f1)）"
done

if [ "$WITH_ASSETS" = 0 ]; then
  echo "（不含 public/assets 与 public/fonts：在手机上导入素材包，见 android/tools/pack-assets.sh）"
fi

echo "打包中…（$STAGE → $ZIP）"
ZIP_WIN="$ZIP"
if command -v cygpath >/dev/null 2>&1; then ZIP_WIN="$(cygpath -m "$ZIP")"; fi
( cd "$STAGE" && "$JAR" --create --file "$ZIP_WIN" . )
rm -rf "$STAGE"

echo "已生成 $ZIP"
echo "  大小 $(du -h "$ZIP" | cut -f1)"
echo "  构建：MODE=offline bash android/build.sh"
