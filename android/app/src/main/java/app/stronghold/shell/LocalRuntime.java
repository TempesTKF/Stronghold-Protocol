package app.stronghold.shell;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 本地模式：在手机上运行本仓库的 Node 服务器（server/index.js），WebView 再加载 127.0.0.1。
 *
 * 这是「可选内容」：默认不内置运行时与游戏文件，因此本类会在 available() 处返回 false，
 * 设置页的本地模式按钮保持禁用并给出说明。要启用，按 android/README.md 的「本地模式」一节准备：
 *
 *   android/runtimes/<abi>/lib*.so    面向 Android 的 node 可执行文件
 *                                     （必须叫 lib*.so：APK 的 lib/<abi>/ 只解压 *.so，
 *                                      Android 10+ 也只允许从 nativeLibraryDir 执行二进制）
 *   android/app/src/main/assets/game/…  本仓库的 server/ public/ data/ shared/ packs/ 与 node_modules/ws
 *                                     （不含美术音频，见仓库 AGENTS.md「No game art in git」）
 *
 * 服务端只依赖 Node 核心模块 + ws（纯 JS），没有原生扩展、worker_threads、child_process，
 * 因此只要运行时能起来，仓库代码无需任何改动。
 */
final class LocalRuntime {

    private static final String TAG = "StrongholdNode";

    private Process process;

    static File nodeBinary(Context context) {
        return new File(context.getApplicationInfo().nativeLibraryDir, "libnode.so");
    }

    static File gameDir(Context context) {
        return new File(context.getFilesDir(), "game");
    }

    static boolean runtimePresent(Context context) {
        return nodeBinary(context).isFile();
    }

    static boolean gamePresent(Context context) {
        return new File(gameDir(context), "server/index.js").isFile();
    }

    /** 运行时在位、且游戏文件已就绪（必要时从 assets 首次解压）时返回 true。 */
    static boolean available(Context context) {
        if (!runtimePresent(context)) return false;
        if (gamePresent(context)) return true;
        try {
            extractGame(context);
        } catch (IOException e) {
            Log.w(TAG, "extract game failed: " + e);
        }
        return gamePresent(context);
    }

    private static void extractGame(Context context) throws IOException {
        AssetManager assets = context.getAssets();
        String[] top = assets.list("game");
        if (top == null || top.length == 0) return;
        for (String child : top) copyTree(assets, "game/" + child, new File(gameDir(context), child));
    }

    private static void copyTree(AssetManager assets, String assetPath, File target) throws IOException {
        String[] children = assets.list(assetPath);
        if (children == null || children.length == 0) {
            copyFile(assets, assetPath, target);
            return;
        }
        if (!target.exists() && !target.mkdirs()) throw new IOException("mkdirs failed: " + target);
        for (String child : children) copyTree(assets, assetPath + "/" + child, new File(target, child));
    }

    private static void copyFile(AssetManager assets, String assetPath, File target) throws IOException {
        InputStream in = assets.open(assetPath);
        try {
            File parent = target.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IOException("mkdirs failed: " + parent);
            }
            OutputStream out = new FileOutputStream(target);
            try {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = in.read(buffer)) > 0) out.write(buffer, 0, count);
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
    }

    /** 启动 node server/index.js；环境沿用上游的 PORT / HOST 变量。 */
    void start(Context context, int port) throws IOException {
        File node = nodeBinary(context);
        File directory = gameDir(context);
        if (!node.isFile()) throw new IOException("missing runtime: " + node);
        if (!gamePresent(context)) throw new IOException("missing game files: " + directory);

        List<String> command = new ArrayList<>();
        command.add(node.getAbsolutePath());
        command.add("server/index.js");
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(directory);
        builder.redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        env.put("PORT", String.valueOf(port));
        env.put("HOST", "127.0.0.1");     // 只监听本机；要让同 Wi-Fi 的队友进房改成 0.0.0.0
        env.put("SP_ASSET_INDEX", "0");   // 手机上跳过对全部素材的内容哈希索引（首启省一次全量 SHA-256）
        env.put("SP_NO_BROWSER", "1");
        env.put("NODE_ENV", "production");
        env.put("HOME", context.getFilesDir().getAbsolutePath());
        env.put("TMPDIR", context.getCacheDir().getAbsolutePath());
        env.put("LD_LIBRARY_PATH", context.getApplicationInfo().nativeLibraryDir);
        process = builder.start();
        Log.i(TAG, "node started: " + node + " cwd=" + directory);
        drain(process);
    }

    void stop() {
        if (process != null) {
            Log.i(TAG, "node stop");
            process.destroy();
            process = null;
        }
    }

    private static void drain(final Process target) {
        Thread thread = new Thread(() -> {
            try {
                BufferedReader reader = new BufferedReader(new InputStreamReader(target.getInputStream()));
                String line;
                while ((line = reader.readLine()) != null) Log.i(TAG, line);
            } catch (IOException ignored) {
                // 进程退出时读流会异常，属正常
            }
        }, "node-log");
        thread.setDaemon(true);
        thread.start();
    }

    /** 轮询上游的健康检查端点，直到服务器可用（/healthz 由 server/http/routes.js 提供）。 */
    static boolean waitHealthy(int port, long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/healthz").openConnection();
                connection.setConnectTimeout(1500);
                connection.setReadTimeout(1500);
                if (connection.getResponseCode() == 200) return true;
            } catch (Exception ignored) {
                // 服务器还没起来：继续等
            } finally {
                if (connection != null) connection.disconnect();
            }
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }
}
