# Android 外壳

把本仓库的浏览器客户端装进 Android WebView，让手机不必用浏览器打开。**不改动 `server/`、`public/`、
`shared/` 的任何代码**——外壳只决定"加载哪个 origin"，游戏客户端与素材仍由服务器分发。

## 为什么这样切

客户端是**由它所连的服务器分发**的：`public/js/net.js` 让页面回连 `ws(s)://<location.host>/ws`，
素材走 `/data/`、`/vendor/` 等绝对路径，`hello` 消息还带 `PROTOCOL_VERSION` 做版本校验。所以：

- **联机 / 局域网**：外壳加载哪台服务器，就用哪台的客户端与素材，版本天然一致——与手机浏览器打开
  同一地址完全等价。服务器换版本、加功能，外壳都不用改。
- **本地模式**：由手机自己跑 `server/index.js`（Node），WebView 加载 `127.0.0.1`。服务端只依赖
  Node 核心模块 + `ws`（纯 JS，无原生扩展、无 `worker_threads`、无 `child_process`），所以只要运行时
  能起来，仓库代码零改动。见下面「本地模式」。

## 构建

要求：**JDK 17+** 与 **Android SDK**（`build-tools;36.0.0`、`platforms;android-36`）。
脚本会自动探测 `ANDROID_SDK_ROOT` / `ANDROID_HOME` / `%LOCALAPPDATA%\Android\Sdk` 与
`JDK_HOME` / `JAVA_HOME` / Android Studio 自带的 JBR；`JAVA_HOME` 只作候选并实测 `bin/javac` 是否存在
（指向已卸载 JDK 的残留变量很常见）。

```bash
bash android/build.sh
```

产物 `android/build/stronghold-shell-debug.apk`，**版本号跟随 `shared/constants.js` 的 `APP_VERSION`**
（versionName 原样，versionCode = major×10000 + minor×100 + patch，如 `0.2.6` → `206`），
用 Android 标准的调试 keystore `~/.android/debug.keystore` 签名（不存在时自动生成；与 Android Studio
用同一份，换机器也能覆盖安装）。
流水线不依赖 Gradle / Android Studio：`aapt2 compile` → `aapt2 link` → `javac`（`-source/-target 8`，
bootclasspath 为 `android.jar` + `core-lambda-stubs.jar`）→ `d8` → `jar` 打包 → `zipalign -p 4` →
`apksigner`。

安装：

```bash
adb install -r android/build/stronghold-shell-debug.apk
```

## 使用

首次启动是设置页：填开服电脑的地址（同一 Wi-Fi 的局域网 IP，如 `192.168.1.5:3000`；或公网 / 隧道
域名），连接后地址会记住，下次直接进游戏。游戏内**返回键**弹出「切换服务器 / 退出 / 继续游戏」。

外壳为游戏做的适配：

- 沉浸式横屏全屏（`sensorLandscape`、刘海 `shortEdges`）、保持屏幕常亮；
- WebView 开 DOM storage（游戏把显示设置、术语偏好、重连信息存在 localStorage）、免手势媒体播放
  （BGM / 语音 / 音效不需要先点一下）、关缩放与文件访问；
- 实现 `WebChromeClient.onShowCustomView`：游戏用 Fullscreen API 请求全屏（`public/js/ui/device.js`），
  不实现这个回调，它的全屏按钮点了不会有反应；
- 局域网 http 需要明文流量，清单里已开 `usesCleartextTraffic`；
- debug 构建开着 `WebView.setWebContentsDebuggingEnabled`，可用 Chrome 的 `chrome://inspect` 远程调试。

## 本地模式（可选，当前未随包提供）

设置页的「本地模式」按钮在**运行时与游戏文件都在位**时才可用。启用方法：

1. `android/runtimes/<abi>/lib*.so` —— 面向 Android 的 Node 22+ 可执行文件。**文件名必须是 `lib*.so`**：
   APK 的 `lib/<abi>/` 只解压 `*.so`，而且 Android 10+ 只允许从 `nativeLibraryDir` 执行二进制，
   不能从可写目录启动。
2. `android/app/src/main/assets/game/` —— 本仓库的 `server/ public/ data/ shared/ packs/` 与
   `node_modules/ws`（**不含**美术音频；见仓库 AGENTS.md「No game art in git」）。首次启动解压到
   `filesDir/game`。

构建脚本检测到这两项就会打进 APK。启动时外壳设置 `PORT`、`HOST=127.0.0.1`、`SP_ASSET_INDEX=0`
（跳过对全部素材做内容哈希索引，手机上省一次全量 SHA-256）、`HOME` / `TMPDIR`，并用
`/healthz` 轮询等服务器就绪。

**当前的障碍**：没有现成的 Android arm64 Node 运行时——Node 官方与 unofficial-builds 的平台列表里
都没有 `android-arm64`，`nodejs-mobile` 已归档且停在 Node 18。要么自行交叉编译 Node，要么改造 Termux
的 `nodejs-lts` aarch64 包（连同 `libc++_shared`、`libicu`、`openssl` 等依赖一起放进 `lib/`，用
`/system/bin/linker64 --library-path` 拉起）。两条路都必须**在真机上验证**。

## 状态

已在本机验证（用 Android SDK 的模拟器，API 36 AOSP x86_64 + AEHD 加速）：

- 构建全流程通过，`zipalign -c 4` 通过，`apksigner` 报 v2 + v3 通过；
- `classes.dex` 头合法、`resources.arsc` 不压缩存放、自适应图标与设置页布局齐备；
- 包内中文文案完整（`resources.arsc` 中可检索到 UTF-8 的界面文案）。

仍需真机验收：真实触控拖拽 / 长按详情的手感、音频、WebGL 帧率、刘海安全区，
以及本地模式整体的可用性。
