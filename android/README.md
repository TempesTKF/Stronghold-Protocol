# Android 外壳

把本仓库的浏览器客户端装进 Android WebView，手机不用浏览器也能玩。**不改动 `server/`、`public/`、
`shared/` 的任何代码**——外壳只负责"从哪里加载"。

同一份源码出两个构建：

| | 联机版（默认） | 离线版 |
|---|---|---|
| 构建 | `bash android/build.sh` | `MODE=offline bash android/build.sh` |
| APK | 约 25 KB | 约 620 MB（含 550MB 素材）或约 60 MB（`--no-assets`） |
| 包名 | `app.stronghold.shell` | `app.stronghold.shell.offline`（可与联机版共存） |
| 默认 | 连 `default_server`（`res/values/strings.xml`） | 手机本地开服（内置 Node 运行时 + 游戏文件），不需要网络 |
| 也能 | 切换服务器 | 切换服务器 |

## 为什么这样切

客户端是**由它所连的服务器分发**的：`public/js/net.js` 让页面回连 `ws(s)://<location.host>/ws`，
素材走 `/data/`、`/vendor/` 等绝对路径，`hello` 消息带 `PROTOCOL_VERSION` 做版本校验。所以：

- **联机版**：外壳加载哪台服务器，就用哪台的客户端与素材，版本天然一致——与手机浏览器打开同一地址等价。
- **离线版**：由手机自己跑 `server/index.js`，WebView 加载 `127.0.0.1`。服务端只依赖 Node 核心
  模块 + `ws`（纯 JS，无原生扩展、无 `worker_threads`、无 `child_process`），所以仓库代码零改动。

## 构建

要求：**JDK 17+** 与 **Android SDK**（`build-tools;36.0.0`、`platforms;android-36`）。脚本自动探测
`ANDROID_SDK_ROOT` / `ANDROID_HOME` / `%LOCALAPPDATA%\Android\Sdk` 与 `JDK_HOME` / `JAVA_HOME` /
Android Studio 自带的 JBR；`JAVA_HOME` 只作候选并实测 `bin/javac`（指向已卸载 JDK 的残留变量很常见）。

```bash
bash android/build.sh                        # → android/build/stronghold-shell-debug.apk（约 25 KB）
```

流水线不依赖 Gradle / Android Studio：`aapt2 compile` → `aapt2 link` → `javac`（`-source/-target 8`，
bootclasspath 为 `android.jar` + `core-lambda-stubs.jar`）→ `d8` → `jar` 打包 → `zipalign -p 4` →
`apksigner`。版本号跟随 `shared/constants.js` 的 `APP_VERSION`（versionName 原样，versionCode =
major×10000 + minor×100 + patch，如 `0.2.6` → `206`；离线版版本名加 `-offline`），签名用 Android
标准的调试 keystore `~/.android/debug.keystore`（不存在时自动生成）。

### 离线版

```bash
bash android/tools/stage-runtime.sh              # 取 Termux 的 node 与依赖库 → android/runtimes/<abi>/
bash android/tools/stage-game.sh                 # 收拢游戏文件（含素材）→ android/app/src/main/assets/game.zip
MODE=offline bash android/build.sh               # → android/build/stronghold-offline-arm64-v8a-debug.apk
```

- **运行时**（`android/tools/stage-runtime.sh`）：从 Termux 镜像取 `nodejs-lts`（现为 **Node 24.18.0**）
  与它 `DT_NEEDED` 里真正引用的库——`libc++_shared.so`、`libcares.so`、`libcrypto.so.3`、`libssl.so.3`、
  `libicuuc.so.78`、`libicui18n.so.78`、`libicudata.so.78`、`libsqlite3.so`、`libz.so.1`
  （`libc`/`libdl`/`libm` 由 Android 提供）。它们以 `lib/<abi>/*.so*` 打进 APK，安装后位于
  `nativeLibraryDir`——Android 10+ 只允许从这里执行二进制。合计约 89 MB（APK 里压缩后约 24 MB）。
- **游戏文件**（`android/tools/stage-game.sh`）：`server/ shared/ data/ packs/ public/ package.json`
  与 `node_modules/ws`，**加上素材就是那 550MB**（`npm run setup` 下过才有；`--no-assets` 可以只打 6MB
  的骨架用于跑流程）。打成一个 `assets/game.zip`：Android 的 `AssetManager.list()` 数不出压缩的
  assets，单个 zip 只要一个流就能读，运行期解压也快。
- **首次启动**：`LocalRuntime` 把 `game.zip` 流式解压到 `filesDir/game`（显示进度），写一个版本标记；
  APK 版本变了会重新解压。随后以 `PORT=3000 HOST=127.0.0.1 SP_ASSET_INDEX=0` 启动 `server/index.js`
  （`SP_ASSET_INDEX=0` 是为了跳过对 790MB 素材做内容哈希索引），轮询 `/healthz` 就绪后加载
  `http://127.0.0.1:3000/`。
- 代码在 `android/app/src/main/java/app/stronghold/shell/`：`MainActivity`（WebView、三种界面、探活）、
  `LocalRuntime`（解压与启动本机服务器）、`BuildMode`（构建期常量，`build.sh` 在 `MODE=offline` 时
  用 `build/gen-src` 里的另一份替换源码树里那份）。
- **离线版要求 Android 11+**（minSdk 30）：带版本号的 `.so` 名字能否被安装器解压出来只在 API 36 上实测过。

## 使用

```bash
adb install -r android/build/stronghold-shell-debug.apk
```

首次启动：联机版直接进 `default_server`；离线版先解压内置素材（十几秒到一分钟）再进游戏。游戏内
**返回键**弹出「切换服务器 / 退出」；设置页可以改地址、恢复默认，离线版还多一个「本地模式」按钮。
局域网 http 需要明文流量（清单已开 `usesCleartextTraffic`）；debug 构建开着
`WebView.setWebContentsDebuggingEnabled`，可用 Chrome 的 `chrome://inspect` 远程调试。

外壳为游戏做的适配：沉浸式横屏全屏（`sensorLandscape`、刘海 `shortEdges`）、保持屏幕常亮、
DOM storage（显示设置与重连信息）、免手势媒体播放、关缩放与文件访问，以及
**`WebChromeClient.onShowCustomView`**——游戏用 Fullscreen API 请求全屏，不实现这个回调，
它的全屏按钮点了不会有反应。连接前先探一次 `/healthz`：不是游戏服务器（有响应但 `/healthz` 不像
游戏状态）会给明确提示并允许「仍然打开」，连不上则给出带地址的错误页，而不是把别人的页面显示出来。

## 状态

已在 Android 16（API 36）x86_64 模拟器上验证：

- **联机版**：安装启动、沉浸横屏、填地址连接、加载服务器上的客户端、WebSocket 连上（顶栏显示延迟）、
  服务器大厅完整渲染、创建同盟并加 3 个 AI 队友、进入「确认本局信息」；地址与 `localStorage` 跨重启保留；
  连不上与「不是游戏服务器」两种错误页；返回键对话框（Android 16 默认启用预测性返回，`onBackPressed`
  不再被调用，已改为注册 `OnBackInvokedCallback`）。
- **离线版**：内置运行时（Termux 的 Node 24.18.0）从 `nativeLibraryDir` 启动成功、`game.zip` 解压
  （630 个文件的骨架版）、本机服务器在手机侧起来（日志里的 `Local: http://127.0.0.1:3000`）、
  WebView 从 `127.0.0.1` 加载并进入标题页；无任何外部服务器参与。
- 页面的 `console` 会转发到 logcat：`adb logcat -s StrongholdShell:* StrongholdNode:*`。

仍需真机验收：真实触控手感、音频、WebGL 帧率、刘海安全区、离线版首次解压 550MB 的耗时与占用
（装上后约占 1.15GB：APK 620MB + 解压后 550MB）。

### 在模拟器上验证

```bash
sdkmanager "emulator" "system-images;android-36;default;x86_64"     # 一次性准备
avdmanager create avd -n stronghold -k "system-images;android-36;default;x86_64" -d pixel_10
emulator -avd stronghold -no-window -no-audio -no-boot-anim -gpu host &
adb wait-for-device
adb install -r android/build/stronghold-shell-debug.apk
adb shell am start -n app.stronghold.shell/.MainActivity
adb exec-out screencap -p > shot.png      # 截图（exec-out 是二进制安全的，不要用 shell 重定向）
adb shell input tap 1200 700              # 点按：坐标从截图量（WebView 内容不进无障碍树）
adb shell input text "10.0.2.2:3000"      # 模拟器里 10.0.2.2 就是宿主的回环地址
adb logcat -s StrongholdShell:* StrongholdNode:*
```

三个坑：**WebView 里的 DOM 不会出现在 `uiautomator dump`**（整个 WebView 是一个不透明节点），
游戏内部只能靠截图量坐标驱动；**模拟器的 GPU 是转发或软件渲染**，帧率数字不代表真机；
Git Bash 里给 `adb shell` 传设备绝对路径要设 `MSYS_NO_PATHCONV=1`（但别在跑构建脚本时设，会弄坏它内部的路径）。

## 运行时与素材的授权

离线版会把 Termux 的 Node 二进制（Node 是 MIT、ICU 是 Unicode 许可、OpenSSL 是 Apache-2.0，
各自的许可证文本随 Termux 包分发）与《明日方舟》的游戏素材（版权归原权利人、**不适用**本仓库的
GPL，仅限非商业使用，见仓库根 [NOTICE.md](../NOTICE.md)）一起打包。自己人内部使用没问题，
请不要公开分发这个离线包。
