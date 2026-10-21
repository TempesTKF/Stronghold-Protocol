# Android 外壳

把本仓库的浏览器客户端装进 Android WebView，手机不用浏览器也能玩。**不改动 `server/`、`public/`、
`shared/` 的任何代码**——外壳只负责"从哪里加载"。

同一份源码出两个构建：

| | 联机版（默认） | 离线版 |
|---|---|---|
| 构建 | `bash android/build.sh` | `MODE=offline bash android/build.sh` |
| APK | 约 25 KB | 自带全部素材约 1.1 GB（`--assets-from`，含 3D 战场与官方特效）；不带素材约 45 MB。皮肤包都在手机上单独导入 |
| 包名 | `app.stronghold.shell` | `app.stronghold.shell.offline`（可与联机版共存） |
| 默认 | 首次打开停在首页填服务器地址（不内置默认服务器），之后直接连上次的地址 | 首次打开停在首页选「本地离线」或「联机」，之后进上次的模式 |
| 也能 | 切换服务器 | 切换服务器 |

## 为什么这样切

客户端是**由它所连的服务器分发**的：`public/js/net.js` 让页面回连 `ws(s)://<location.host>/ws`，
素材走 `/data/`、`/vendor/` 等绝对路径，`hello` 消息带 `PROTOCOL_VERSION` 做版本校验。所以：

- **联机版**：外壳加载哪台服务器，就用哪台的客户端与素材，版本天然一致——与手机浏览器打开同一地址等价。
- **离线版**：由手机自己跑 `server/index.js`，WebView 加载 `127.0.0.1`。服务端只依赖 Node 核心
  模块与纯 JS 的 `ws` / `ses` / `acorn`（无原生扩展），所以仓库代码零改动。0.3.0 起带玩法插件的房间、
  受信插件与插件工作台会用 `child_process.fork` 另起 node：`fork` 用的是 `process.execPath`，即
  `nativeLibraryDir` 里的 `libnode.so`，同样可执行；原版内容（不装插件）只有一个进程，工作台在手机上关掉
  （`SP_STUDIO=off`）。服务器大厅（`/api/lobby`、匹配、公开房间）是同一台服务器的接口，离线时就是手机自己的大厅。

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
bash android/tools/stage-game.sh --assets-from <解开的 Stronghold-Protocol-v<版本>.zip 根目录>
                                                 # 收拢游戏文件 + 全部素材 → android/app/src/main/assets/game.zip
                                                 # （不加 --assets-from 就是不带素材的小包，素材在手机上导入）
MODE=offline bash android/build.sh               # → android/build/stronghold-offline-arm64-v8a-debug.apk
bash android/tools/pack-assets.sh                # 可选：素材包 → android/build/stronghold-assets-<版本>.zip（手机上导入）
```

- **运行时**（`android/tools/stage-runtime.sh`）：从 Termux 镜像取 `nodejs-lts`（现为 **Node 24.18.0**）
  与它 `DT_NEEDED` 里真正引用的库——`libc++_shared.so`、`libcares.so`、`libcrypto.so.3`、`libssl.so.3`、
  `libicuuc.so.78`、`libicui18n.so.78`、`libicudata.so.78`、`libsqlite3.so`、`libz.so.1`
  （`libc`/`libdl`/`libm` 由 Android 提供）。它们以 `lib/<abi>/*.so*` 打进 APK，安装后位于
  `nativeLibraryDir`——Android 10+ 只允许从这里执行二进制。合计约 89 MB（APK 里压缩后约 24 MB）。
  下载逐层校验，任一处不符即中止：`Packages` 索引的 SHA256 与同一镜像的 `InRelease` 核对（设
  `TERMUX_KEYRING` 且装了 `gpgv` 时再验 `InRelease` 签名）；每个 `.deb` 与索引里的 SHA256 核对；
  有锁文件 `android/tools/termux-runtime.lock` 时还要与它一致（`--write-lock` 生成/升级）；解包前拒绝
  绝对路径与含 `..` 的成员，挑出的文件解析软链后必须仍在解包目录内且是 ELF。
- **游戏文件**（`android/tools/stage-game.sh`）：`server/ shared/ data/ packs/ plugins/ schemas/ tools/
  public/ package.json`，以及服务端 import 的包（`ws ses acorn`）按 `package-lock.json` 求出的依赖闭包
  （`plugins/`、`schemas/`、`tools/` 与 `ses`/`acorn` 是 0.3.x 起服务端启动或建房时会读到的），
  **加上素材就是那 550MB**（`npm run setup` 下过才有；`--no-assets` 可以只打约 9MB 的骨架用于跑流程）。
  运行期解压时拒绝跳出 `filesDir/game` 的条目（zip slip）。打成一个 `assets/game.zip`：Android 的 `AssetManager.list()` 数不出压缩的
  assets，单个 zip 只要一个流就能读，运行期解压也快。
- **首次启动**：`LocalRuntime` 把 `game.zip` 流式解压到 `filesDir/game`（显示进度），写一个版本标记；
  APK 版本变了会重新解压。随后以 `PORT=3000 HOST=127.0.0.1 SP_ASSET_INDEX=0` 启动 `server/index.js`
  （`SP_ASSET_INDEX=0` 是为了跳过对 790MB 素材做内容哈希索引），轮询 `/healthz` 就绪后加载
  `http://127.0.0.1:3000/`。
- **随时重连对局**：本机服务器由前台服务 `LocalServerService` 持有（常驻通知，带「停止」按钮），
  返回键「退出」、界面被系统回收、切后台都不会停它；回到应用时若 `/healthz` 仍应答就直接加载，页面用
  `localStorage` 里的令牌重连原来的对局。服务端入口是 `android-entry.mjs`（源文件
  `android/tools/offline-entry.mjs`，由 `stage-game.sh` 放进游戏目录），它把 `emptyRoomMs`（TKF 加的
  "无人在线 5 分钟解散房间"，单人对局也会被收）、`reconnectWindowMs`（10 分钟）与
  `soloReconnectWindowMs`（24 小时）都拉到 20 天，不改 `server/` 代码。单人对局在离开期间停着等；
  带 AI 队友的同盟房间按服务器的托管规则继续进行。服务器进程被结束（通知上点「停止」、系统强杀、
  重启手机、升级 APK）后对局不会保留——服务端本身不落盘对局状态。
- **素材包与皮肤包单独导入**（`ContentStore`）：APK 只带游戏本体。首页「素材与皮肤 → 导入素材包 / 皮肤包」
  用系统文件选择器选手机里的 zip（选择器默认从「下载」目录打开），或者在浏览器的下载列表 / 文件管理器里点 zip、
  选「卫戍协议」打开（离线版清单里的 `ACTION_VIEW` + `application/zip`，只认 `content://`；`build.sh` 只在
  `MODE=offline` 时把 `OFFLINE_ZIP_FILTER` 那行换成这个 intent filter，联机版没有导入、不出现在「打开方式」里），
  App 回到首页直接导入。都不需要存储权限。zip 流式解到 `filesDir/content/{assets,fonts,plugins/<id>}`——放在游戏目录
  外面，APK 升级重新解压游戏目录时不受影响；再用软链接进 `game/public/assets`、`game/public/fonts`、
  `game/plugins/<id>`（每次开服前与导入后各链一次，幂等；删除游戏目录时只删链接不进去）。一个 zip 里按路径
  分两类：`assets/…`、`fonts/…`（可带 `public/` 或 `<一层>/public/` 前缀）是素材，逐文件并入；带
  `plugin.json` 的顶层文件夹是插件，整个替换同名旧版。条目先解到 `content/.incoming` 全部写完再移到位，
  绝对路径、`..` 与解析后跳出暂存目录的条目整包拒绝；导入前按 zip 大小检查剩余空间。本机服务器在运行时
  也能导入：素材按文件读，插件目录变化服务器自己会重新扫描（桌面上用目录联接模拟验证过）。
  - 素材包：`android/tools/pack-assets.sh` 把 `public/assets` + `public/fonts` 打成不压缩的 zip（要和 APK
    同一版本：`data/assets.json` 在 APK 里）。不导入也能玩，画面用默认图形。
  - 上游完整发布包 `Stronghold-Protocol-v<版本>.zip`（v0.3.1 为 845MB）可以原样导入：除了基础素材，还带维护者
    本地提取的官方素材 `public/assets/local/**`（11 张 3D 战场场景、棋盘贴图、官方战斗特效、41 个召唤物模型等）
    和它们的清单 `data/local-assets.json`、`data/local-fx.json`；清单存到 `content/data/`，链成 `game/data/`
    下的同名文件。包里的代码、文档、依赖不要，暂存后丢弃。lite 包与 update 包不含素材。
  - 皮肤包：TKF v0.3.1 发布的 `official-operator-skins.zip`（404MB，4 个外观插件、274 套皮肤）原样导入即可；
    玩家在游戏的 设置 → 外观插件 里打开。
  - APK 自带素材时（`--assets-from` / `--with-assets`），游戏目录里的 `public/assets` 等是真实目录，导入的素材
    不会链进去（链接只在没有同名真实目录时建立）；这种构建只需要导入皮肤包。
  - 「清除已导入」删掉 `content/` 并拆掉链接。这些都是官方美术，只供个人使用，不要分发。
  - 想把插件直接打进 APK 也行：`stage-game.sh --plugins <目录>`（不跟随软链）；`--with-assets` 把素材打进 APK。
- **隐藏网页端才有用的控件**：外壳在页面加载时注入一个 `<style>`（`MainActivity.injectShellStyle`），不改
  `public/`。`res/raw/shell.css` 两个构建都注入：全屏切换按钮（外壳本来就是沉浸式全屏）。
  `res/raw/shell_local.css` 只在本地模式注入：延迟显示、服务器大厅的统计与公开房间列表、匹配房间、
  密钥 / 邀请链接加入、观战、复制密钥 / 链接、标题页「下载完整素材」。「添加到桌面」（PWA）在 WebView 里
  本来就不出现。选择器依赖客户端现有类名（文件里逐条注明出处），客户端改名后要跟着改；「公开房间」开关
  只能靠翻译过的 aria-label 定位，太脆，保留未隐藏。
- 代码在 `android/app/src/main/java/app/stronghold/shell/`：`LocalServerService`（前台服务，持有 node 进程）、`MainActivity`（WebView、三种界面、探活）、
  `LocalRuntime`（解压与启动本机服务器）、`BuildMode`（构建期常量，`build.sh` 在 `MODE=offline` 时
  用 `build/gen-src` 里的另一份替换源码树里那份）。
- **离线版要求 Android 11+**（minSdk 30）：带版本号的 `.so` 名字能否被安装器解压出来只在 API 36 上实测过。

## 使用

```bash
adb install -r android/build/stronghold-shell-debug.apk
```

首次启动：两个包都不内置默认服务器，地址栏留空（只显示灰色示例），连过一次之后记住并回填上次的地址。
联机版停在首页填地址；离线版停在首页，三块——**本地离线**（手机自己开服）、
**联机**（填服务器地址，和用浏览器玩的博士进同一批房间；页面由那台服务器提供，与网页端完全一样，
只隐藏了全屏按钮）、**素材与皮肤**（导入 / 清除）。之后每次打开直接进上次的模式。游戏内
**返回键**弹出「切换模式 / 服务器」与「退出」，前者回到首页。从本地切到联机时本机服务器继续在后台跑，
切回来还能接着打原来的对局。
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

移植到 0.3.1（TKF master `5046ecc3`）后在桌面上验证过：`stage-game.sh --no-assets` 产出的 `game.zip`
解压到空目录，以 `LocalRuntime` 的环境变量启动 `server/index.js`，`/healthz`、`/api/lobby`、`/vendor/`
都可用，WebSocket 能建单人房并开局到「确认本局信息」，浏览器里标题页与服务器大厅正常渲染。
页面引用的 Google Fonts 离线时取不到，会回落到系统字体（素材包里的 `public/fonts` 不受影响）。
同日在 Windows（Git Bash、路径含空格、Temurin 21、build-tools 36.0.0、android-36 r02）上跑通了
`stage-runtime.sh --write-lock arm64-v8a` → `stage-game.sh --no-assets` → `MODE=offline build.sh`
（APK 约 43MB）；`termux-runtime.lock` 就是那次的结果。装机运行（前台服务、重连、触控、音频、WebGL、
首次解压耗时）还没在真机或模拟器上验证。

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

### 诊断小工具

离线版首页报「本机服务器启动失败：node exited (…)」而玩家手里没有 adb 时，给他装 `android/diag`
（包名 `app.stronghold.diag`，约 21KB，`bash android/diag/build.sh` → `android/build/diag/stronghold-diag-debug.apk`）。
它和游戏是两个包，只读离线版的安装包与 `nativeLibraryDir`，不碰离线版的数据、设置和正在运行的服务器：
报告设备与系统、两个包的版本、3000 端口被谁占用、APK 里的 `lib/` 与手机上实际解出的库是否一致，
用离线版的 `libnode.so` 跑 `assets/checks.js`（网络接口、加密、Intl、临时目录、监听端口），
再把 `game.zip` 里除素材外的服务端代码解到自己的缓存目录，按 `LocalRuntime.start` 的环境变量在
39170 端口试跑 `android-entry.mjs`，node 的原始输出整段进报告。玩家点「复制报告」或「分享报告」发回来。
离线版数据目录里导入的皮肤插件别的应用读不到，试跑不含它们。

## 运行时与素材的授权

离线版会把 Termux 的 Node 二进制（Node 是 MIT、ICU 是 Unicode 许可、OpenSSL 是 Apache-2.0，
各自的许可证文本随 Termux 包分发）与《明日方舟》的游戏素材（版权归原权利人、**不适用**本仓库的
GPL，仅限非商业使用，见仓库根 [NOTICE.md](../NOTICE.md)）一起打包。自己人内部使用没问题，
请不要公开分发这个离线包。
