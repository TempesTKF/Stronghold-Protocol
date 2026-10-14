package app.stronghold.shell;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
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
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 本地模式（离线版内置）：APK 里带着 Node 运行时与整份游戏文件，首次启动解压到 filesDir，
 * 再启动本机服务器（server/index.js），WebView 加载 127.0.0.1——全程不需要网络。
 *
 * 运行时由 android/tools/stage-runtime.sh 从 Termux 的 nodejs-lts 与依赖里取出，
 * 以 lib/&lt;abi&gt;/lib*.so 打进 APK（安装后位于 nativeLibraryDir——Android 10+ 只允许从这里
 * 执行二进制）；游戏文件由 android/tools/stage-game.sh 收进 assets/game/**。
 *
 * 服务端只依赖 Node 核心模块 + ws，没有任何原生扩展，所以仓库代码零改动。
 */
final class LocalRuntime {

    private static final String TAG = "StrongholdNode";
    private static final String MARKER = ".staged-version";
    /** 内置游戏文件的打包（android/tools/stage-game.sh 生成；单个 zip 便于流式解压）。 */
    private static final String GAME_ZIP = "game.zip";

    /** 解压进度（在后台线程回调，调用方自己切回主线程）。 */
    interface Progress {
        void onMessage(String message);
    }

    /** 安装包里缺运行时或游戏文件。 */
    static final class Missing extends Exception {
        Missing(String message) {
            super(message);
        }
    }

    private Process process;
    private Context context;
    private Progress progress;
    private int extracted;

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

    /** assets 里有没有游戏文件（离线版才有）。用一个流探一下，不用 AssetManager.list——
     *  list() 数不出压缩的 assets，这也是游戏文件打成单个 zip 的原因。 */
    static boolean gameBundled(Context context) {
        try {
            context.getAssets().open(GAME_ZIP).close();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    static boolean available(Context context) {
        return runtimePresent(context) && gameBundled(context);
    }

    /** 解压内置游戏文件（首次启动，或 APK 版本变化后重来一次）。 */
    void prepare(Context ctx, Progress report) throws IOException, Missing {
        if (!runtimePresent(ctx)) throw new Missing("missing libnode.so");
        if (!gameBundled(ctx)) throw new Missing("missing assets/" + GAME_ZIP);
        this.context = ctx;
        this.progress = report;
        File dir = gameDir(ctx);
        String version = versionName(ctx);
        File marker = new File(dir, MARKER);
        if (gamePresent(ctx) && marker.isFile() && version.equals(readText(marker))) {
            Log.i(TAG, "game files already staged for " + version);
            return;
        }
        if (dir.exists() && !deleteTree(dir)) throw new IOException("cannot clean " + dir);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        report.onMessage(ctx.getString(R.string.local_preparing));
        extracted = 0;
        extractBundle(dir);
        if (!gamePresent(ctx)) throw new IOException("incomplete after extract");
        writeText(marker, version);
        Log.i(TAG, "extracted " + extracted + " files to " + dir);
    }

    /** 启动 node server/index.js；环境沿用仓库的 PORT / HOST 等变量。 */
    void start(Context ctx, int port) throws IOException {
        File node = nodeBinary(ctx);
        File dir = gameDir(ctx);
        if (!node.isFile()) throw new IOException("missing runtime: " + node);
        if (!gamePresent(ctx)) throw new IOException("missing game files: " + dir);

        List<String> command = new ArrayList<>();
        command.add(node.getAbsolutePath());
        command.add("server/index.js");
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(dir);
        builder.redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        env.put("PORT", String.valueOf(port));
        env.put("HOST", "127.0.0.1");
        env.put("SP_ASSET_INDEX", "0");   // 手机上跳过对全部素材做内容哈希索引
        env.put("SP_NO_BROWSER", "1");
        env.put("NODE_ENV", "production");
        env.put("HOME", ctx.getFilesDir().getAbsolutePath());
        env.put("TMPDIR", ctx.getCacheDir().getAbsolutePath());
        env.put("LD_LIBRARY_PATH", ctx.getApplicationInfo().nativeLibraryDir);
        process = builder.start();
        Log.i(TAG, "node started: " + node + " cwd=" + dir);
        drain(process);
    }

    void stop() {
        if (process != null) {
            Log.i(TAG, "node stop");
            process.destroy();
            process = null;
        }
    }

    /** 轮询 /healthz，直到服务器可用。 */
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
                // 还没起来，继续等
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

    // ---- 解压 ------------------------------------------------------------------------------------------------------

    /** 把 assets/game.zip 流式解压到目标目录。 */
    private void extractBundle(File dir) throws IOException {
        ZipInputStream zip = new ZipInputStream(context.getAssets().open(GAME_ZIP));
        byte[] buffer = new byte[65536];
        try {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File target = new File(dir, entry.getName());
                if (entry.isDirectory()) {
                    if (!target.isDirectory() && !target.mkdirs()) throw new IOException("mkdirs failed: " + target);
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new IOException("mkdirs failed: " + parent);
                }
                OutputStream out = new FileOutputStream(target);
                try {
                    int count;
                    while ((count = zip.read(buffer)) > 0) out.write(buffer, 0, count);
                } finally {
                    out.close();
                }
                if (progress != null && ++extracted % 200 == 0) {
                    progress.onMessage(context.getString(R.string.local_extracting, extracted));
                }
            }
        } finally {
            zip.close();
        }
    }

    private void drain(final Process target) {
        Thread thread = new Thread(() -> {
            try {
                BufferedReader reader = new BufferedReader(new InputStreamReader(target.getInputStream()));
                String line;
                while ((line = reader.readLine()) != null) Log.i(TAG, line);
            } catch (IOException ignored) {
                // 进程退出时读流异常，属正常
            }
        }, "node-log");
        thread.setDaemon(true);
        thread.start();
    }

    // ---- 小工具 ----------------------------------------------------------------------------------------------------

    private static String versionName(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName == null ? "0" : info.versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private static boolean deleteTree(File file) {
        File[] children = file.listFiles();
        boolean ok = true;
        if (children != null) {
            for (File child : children) ok &= deleteTree(child);
        }
        return ok && (file.delete() || !file.exists());
    }

    private static String readText(File file) {
        try {
            byte[] buffer = new byte[(int) Math.min(file.length(), 4096)];
            InputStream in = new FileInputStream(file);
            try {
                int read = in.read(buffer);
                return read <= 0 ? "" : new String(buffer, 0, read, "UTF-8").trim();
            } finally {
                in.close();
            }
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File file, String text) throws IOException {
        OutputStream out = new FileOutputStream(file);
        try {
            out.write(text.getBytes("UTF-8"));
        } finally {
            out.close();
        }
    }
}
