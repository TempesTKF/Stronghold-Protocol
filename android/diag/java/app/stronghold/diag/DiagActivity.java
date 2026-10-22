package app.stronghold.diag;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.StatFs;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/**
 * 卫戍协议诊断：离线版首页报「本机服务器启动失败：node exited (…)」时，让玩家装这个小工具跑一遍，把报告复制回来。
 *
 * 只读、不改离线版：读它的安装包（sourceDir）与原生库目录（nativeLibraryDir），这两处任何应用都能读；
 * 用它的 libnode.so 在本工具自己的缓存目录里解出服务端代码（不含素材）、以和 LocalRuntime.start 相同的
 * 环境变量试跑 android-entry.mjs，把 node 的原始输出整段收进报告。离线版的数据目录（导入的皮肤、对局）
 * 别的应用读不到，报告里不会有，也不会被改动。
 */
public final class DiagActivity extends Activity {

    private static final String OFFLINE = "app.stronghold.shell.offline";
    private static final String ONLINE = "app.stronghold.shell";
    /** 离线版本机服务器的端口（MainActivity.LOCAL_PORT）。 */
    private static final int GAME_PORT = 3000;
    /** 试跑服务端用的端口：避开 3000，离线版正开着服务器时也不冲突。 */
    private static final int TRIAL_PORT = 39170;
    private static final String GAME_ZIP = "assets/game.zip";
    private static final String ENTRY = "android-entry.mjs";
    /** node 基础检查脚本（android/diag/assets/checks.js），以 `node -e` 运行。 */
    private static final String CHECKS = "checks.js";

    private TextView report;
    private Button run;
    private volatile boolean running;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        int pad = (int) (12 * getResources().getDisplayMetrics().density);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);

        TextView intro = new TextView(this);
        intro.setText("排查卫戍协议离线版「本机服务器启动失败」。只读取离线版的安装包，不改动它的数据和设置。"
                + "点「开始诊断」，等一两分钟跑完后点「复制报告」或「分享报告」发给开发者。");
        root.addView(intro);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        run = button("开始诊断", v -> startDiagnosis());
        buttons.addView(run);
        buttons.addView(button("复制报告", v -> copyReport()));
        buttons.addView(button("分享报告", v -> shareReport()));
        root.addView(buttons);

        report = new TextView(this);
        report.setTypeface(Typeface.MONOSPACE);
        report.setTextSize(12);
        report.setTextIsSelectable(true);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(report);
        root.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    private Button button(String text, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setOnClickListener(listener);
        return b;
    }

    private void startDiagnosis() {
        if (running) return;
        running = true;
        run.setEnabled(false);
        report.setText("");
        new Thread(() -> {
            try {
                diagnose();
            } catch (Throwable e) {
                line("诊断本身出错：" + e);
            }
            line("");
            line("== 诊断结束 ==");
            running = false;
            runOnUiThread(() -> run.setEnabled(true));
        }, "diag").start();
    }

    private void line(final String text) {
        runOnUiThread(() -> report.append(text + "\n"));
    }

    // ---- 诊断步骤 --------------------------------------------------------------------------------------------------

    private void diagnose() throws Exception {
        line("== 设备 ==");
        line("  型号: " + Build.MANUFACTURER + " " + Build.MODEL + " (" + Build.DEVICE + ")");
        line("  Android: " + Build.VERSION.RELEASE + " / API " + Build.VERSION.SDK_INT);
        line("  系统: " + Build.DISPLAY);
        String harmony = harmonyVersion();
        if (harmony != null) line("  鸿蒙: " + harmony + "（安卓兼容层，上面的 Android 版本是兼容的 API 级别）");
        line("  ABI: " + String.join(",", Build.SUPPORTED_ABIS));
        StatFs data = new StatFs(getFilesDir().getAbsolutePath());
        line("  /data 剩余: " + (data.getAvailableBytes() >> 20) + "MB / " + (data.getTotalBytes() >> 20) + "MB");

        line("");
        line("== 已安装的卫戍协议 ==");
        describePackage(ONLINE);
        ApplicationInfo game = describePackage(OFFLINE);

        line("");
        line("== 端口 " + GAME_PORT + " ==");
        checkPort();

        if (game == null) {
            line("");
            line("没装离线版，后面的检查跳过。");
            return;
        }

        line("");
        line("== 原生库目录 ==");
        File node = checkNativeLibs(game);
        if (node == null) return;

        line("");
        line("== node 基础检查 ==");
        File work = new File(getCacheDir(), "work");
        deleteTree(work);
        work.mkdirs();
        exec(node, game, work, new String[] {"-e", readAll(getAssets().open(CHECKS))}, 30, null);

        line("");
        line("== 试跑服务端（端口 " + TRIAL_PORT + "，不含素材）==");
        File dir = new File(getCacheDir(), "game");
        if (!extractServer(game, dir)) return;
        exec(node, game, dir, new String[] {ENTRY}, 60, "Local:");
        deleteTree(dir);
    }

    /**
     * 鸿蒙（带安卓兼容层的 2.x–4.x）的版本号；不是鸿蒙返回 null。华为的系统类 com.huawei.system.BuildEx
     * 的 getOsBrand() 在鸿蒙上返回 "harmony"，版本号在系统属性 hw_sc.build.platform.version。都靠反射读，
     * 非华为设备上没有这些类，直接返回 null。
     */
    private static String harmonyVersion() {
        try {
            Class<?> buildEx = Class.forName("com.huawei.system.BuildEx");
            Object brand = buildEx.getMethod("getOsBrand").invoke(null);
            if (!"harmony".equalsIgnoreCase(String.valueOf(brand))) return null;
        } catch (Throwable e) {
            return null;
        }
        String version = systemProperty("hw_sc.build.platform.version");
        return version.isEmpty() ? "版本未知" : version;
    }

    private static String systemProperty(String key) {
        try {
            Class<?> properties = Class.forName("android.os.SystemProperties");
            return String.valueOf(properties.getMethod("get", String.class, String.class).invoke(null, key, ""));
        } catch (Throwable e) {
            return "";
        }
    }

    private ApplicationInfo describePackage(String name) {
        PackageManager pm = getPackageManager();
        try {
            PackageInfo info = pm.getPackageInfo(name, 0);
            ApplicationInfo app = info.applicationInfo;
            line("  " + name + ": " + info.versionName + " (" + info.versionCode + ")");
            if (OFFLINE.equals(name)) {
                line("    sourceDir: " + app.sourceDir + " (" + (new File(app.sourceDir).length() >> 20) + "MB)");
                line("    nativeLibraryDir: " + app.nativeLibraryDir);
                line("    extractNativeLibs: "
                        + ((app.flags & ApplicationInfo.FLAG_EXTRACT_NATIVE_LIBS) != 0));
            }
            return app;
        } catch (PackageManager.NameNotFoundException e) {
            line("  " + name + ": 未安装");
            return null;
        }
    }

    /** 3000 端口上是谁：离线版的服务器、别的应用，还是空着。 */
    private void checkPort() {
        String health = null;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("http://127.0.0.1:" + GAME_PORT + "/healthz").openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            int code = connection.getResponseCode();
            InputStream in = code < 400 ? connection.getInputStream() : connection.getErrorStream();
            health = "HTTP " + code + " " + (in == null ? "" : readSome(in, 300));
        } catch (Exception e) {
            health = "连不上（" + e.getClass().getSimpleName() + "）";
        } finally {
            if (connection != null) connection.disconnect();
        }
        line("  GET /healthz: " + health);
        ServerSocket socket = null;
        try {
            socket = new ServerSocket();
            socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), GAME_PORT));
            line("  占用: 空闲（本工具能占到这个端口）");
        } catch (IOException e) {
            line("  占用: 已被占用（" + e.getMessage() + "）");
        } finally {
            try {
                if (socket != null) socket.close();
            } catch (IOException ignored) {
                // 只是试探
            }
        }
    }

    /** 安装包里 lib/ 下打了哪些库、手机上的 nativeLibraryDir 实际解出了哪些——带版本号的 .so 名字可能被安装器漏掉。 */
    private File checkNativeLibs(ApplicationInfo game) {
        File libDir = new File(game.nativeLibraryDir);
        String[] present = libDir.list();
        line("  " + libDir + ": " + (present == null ? "读不到" : present.length + " 个文件"));
        List<String> missing = new ArrayList<>();
        try {
            ZipFile apk = new ZipFile(game.sourceDir);
            try {
                Enumeration<? extends ZipEntry> entries = apk.entries();
                while (entries.hasMoreElements()) {
                    ZipEntry entry = entries.nextElement();
                    String name = entry.getName();
                    if (!name.startsWith("lib/") || entry.isDirectory()) continue;
                    File file = new File(libDir, name.substring(name.lastIndexOf('/') + 1));
                    boolean ok = file.isFile() && file.length() == entry.getSize();
                    line("    " + name + " " + entry.getSize() + " → "
                            + (file.isFile() ? file.length() + (ok ? " ok" : " 大小不符") : "缺失"));
                    if (!ok) missing.add(name);
                }
            } finally {
                apk.close();
            }
        } catch (IOException e) {
            line("  读安装包失败：" + e);
        }
        File node = new File(libDir, "libnode.so");
        if (!node.isFile()) {
            line("  没有 libnode.so，无法继续。");
            return null;
        }
        if (!missing.isEmpty()) {
            line("  有 " + missing.size() + " 个库没解出来或不完整（见上）。");
            line("  结论: 名字不是 lib*.so 的库，Android 12–15 的安装器不解压，node 会因链接失败以退出码 1 结束——"
                    + "android-0.3.1 离线版的已知问题，换用库名修正后的新版即可。");
        }
        return node;
    }

    /** 从离线版安装包里的 game.zip 解出服务端代码（跳过 public/assets 与 public/fonts，几百 MB 的素材试跑用不到）。 */
    private boolean extractServer(ApplicationInfo game, File dir) {
        deleteTree(dir);
        long start = System.currentTimeMillis();
        int count = 0;
        try {
            ZipFile apk = new ZipFile(game.sourceDir);
            try {
                ZipEntry bundle = apk.getEntry(GAME_ZIP);
                if (bundle == null) {
                    line("  安装包里没有 " + GAME_ZIP);
                    return false;
                }
                line("  解压服务端代码（要读一遍约 1GB 的 game.zip，稍等）…");
                ZipInputStream zip = new ZipInputStream(apk.getInputStream(bundle));
                byte[] buffer = new byte[65536];
                String base = dir.getCanonicalPath() + File.separator;
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    String name = entry.getName();
                    if (entry.isDirectory() || name.startsWith("public/assets/") || name.startsWith("public/fonts/")) {
                        continue;
                    }
                    File target = new File(dir, name);
                    if (!target.getCanonicalPath().startsWith(base)) throw new IOException("zip entry outside target: " + name);
                    target.getParentFile().mkdirs();
                    OutputStream out = new FileOutputStream(target);
                    try {
                        int n;
                        while ((n = zip.read(buffer)) > 0) out.write(buffer, 0, n);
                    } finally {
                        out.close();
                    }
                    count++;
                }
                zip.close();
            } finally {
                apk.close();
            }
        } catch (IOException e) {
            line("  解压失败：" + e);
            return false;
        }
        line("  解出 " + count + " 个文件，用时 " + (System.currentTimeMillis() - start) / 1000 + "s");
        return true;
    }

    /**
     * 用离线版的 libnode.so 跑一条命令，环境变量照抄 LocalRuntime.start，输出原样写进报告。
     * ready 不为 null 时：输出里出现它就算启动成功，再探一次 /healthz 后结束进程。
     */
    private void exec(File node, ApplicationInfo game, File cwd, String[] args, int timeoutSec, final String ready)
            throws InterruptedException {
        List<String> command = new ArrayList<>();
        command.add(node.getAbsolutePath());
        for (String a : args) command.add(a);
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(cwd);
        builder.redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        env.put("PORT", String.valueOf(TRIAL_PORT));
        env.put("HOST", "127.0.0.1");
        env.put("SP_ASSET_INDEX", "0");
        env.put("SP_NO_BROWSER", "1");
        env.put("SP_STUDIO", "off");
        env.put("NODE_ENV", "production");
        env.put("HOME", getFilesDir().getAbsolutePath());
        env.put("TMPDIR", getCacheDir().getAbsolutePath());
        env.put("LD_LIBRARY_PATH", game.nativeLibraryDir);
        env.put("GAME_PORT", String.valueOf(GAME_PORT));   // 只给 checks.js 用
        final Process process;
        try {
            process = builder.start();
        } catch (IOException e) {
            line("  启动 node 失败：" + e);
            return;
        }
        final boolean[] seen = {false};
        Thread reader = new Thread(() -> {
            try {
                BufferedReader in = new BufferedReader(new InputStreamReader(process.getInputStream(), "UTF-8"));
                String text;
                while ((text = in.readLine()) != null) {
                    line("  | " + text);
                    if (ready != null && text.contains(ready)) {
                        synchronized (seen) {
                            seen[0] = true;
                        }
                    }
                }
            } catch (IOException ignored) {
                // 进程结束
            }
        }, "diag-node-out");
        reader.start();

        long deadline = System.currentTimeMillis() + timeoutSec * 1000L;
        boolean exited = false;
        while (System.currentTimeMillis() < deadline) {
            if (process.waitFor(300, TimeUnit.MILLISECONDS)) {
                exited = true;
                break;
            }
            boolean up;
            synchronized (seen) {
                up = seen[0];
            }
            if (up) break;
        }
        if (exited) {
            reader.join(2000);
            int code = process.exitValue();
            line("  退出码: " + code + (code > 128 ? "（被信号 " + (code - 128) + " 结束）" : ""));
            if (ready != null) line("  结论: 服务端没能启动，原因见上面 | 开头的输出。");
            return;
        }
        if (ready != null) {
            if (System.currentTimeMillis() >= deadline) {
                line("  结论: " + timeoutSec + "s 内没有启动完成（也没有退出）。");
            } else {
                line("  结论: 服务端在本工具里能正常启动。");
                line("  试探 /healthz: " + healthz(TRIAL_PORT));
            }
        } else {
            line("  超时 " + timeoutSec + "s，结束进程。");
        }
        process.destroy();
        process.waitFor(3, TimeUnit.SECONDS);
        reader.join(2000);
    }

    private static String healthz(int port) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/healthz").openConnection();
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(2000);
            return "HTTP " + connection.getResponseCode() + " " + readSome(connection.getInputStream(), 200);
        } catch (Exception e) {
            return "失败（" + e + "）";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // ---- 报告与小工具 ----------------------------------------------------------------------------------------------

    private void copyReport() {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        clipboard.setPrimaryClip(ClipData.newPlainText("卫戍协议诊断", report.getText()));
        Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show();
    }

    private void shareReport() {
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, report.getText().toString());
        startActivity(Intent.createChooser(send, "分享诊断报告"));
    }

    private static String readSome(InputStream in, int max) throws IOException {
        byte[] buffer = new byte[max];
        int total = 0;
        int n;
        while (total < max && (n = in.read(buffer, total, max - total)) > 0) total += n;
        in.close();
        return new String(buffer, 0, total, "UTF-8").replace('\n', ' ');
    }

    private static String readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) > 0) bytes.write(buffer, 0, n);
        in.close();
        return bytes.toString("UTF-8");
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        file.delete();
    }
}
