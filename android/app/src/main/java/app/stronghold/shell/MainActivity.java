package app.stronghold.shell;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.window.OnBackInvokedDispatcher;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 单 Activity 外壳：沉浸式横屏 WebView 加载客户端。
 *
 * 两种来源，由 {@link BuildMode} 决定首次启动用哪个：
 *   联机版：默认连 default_server（客户端与素材由服务器分发，版本天然一致）。
 *   离线版：默认本地开服（内置 Node 运行时与游戏文件，见 {@link LocalRuntime}），也能切去连服务器。
 * 两者都实现 WebChromeClient.onShowCustomView 对接游戏的全屏按钮，并在连接前先探测 /healthz。
 */
public final class MainActivity extends Activity {

    private static final String TAG = "StrongholdShell";
    private static final String PREFS = "shell";
    private static final String KEY_URL = "serverUrl";
    private static final String KEY_MODE = "mode";
    private static final int LOCAL_PORT = 3000;

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private String currentUrl;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebView.setWebContentsDebuggingEnabled(true);
        // 预测性返回：Android 16（API 36）对 target 36 的应用默认启用，那时 onBackPressed() 不再被调用，
        // 必须注册 OnBackInvokedCallback；旧系统没有这个类，仍走下面的 onBackPressed()。
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::showExitDialog);
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        applyImmersive();

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String mode = prefs.getString(KEY_MODE, null);
        if (mode == null) mode = BuildMode.OFFLINE ? "local" : "remote";
        Log.i(TAG, "start: offline=" + BuildMode.OFFLINE + " mode=" + mode
                + " runtime=" + LocalRuntime.runtimePresent(this)
                + " bundled=" + LocalRuntime.gameBundled(this)
                + " dir=" + getApplicationInfo().nativeLibraryDir);
        if ("local".equals(mode) && LocalRuntime.available(this)) {
            startLocal();
        } else {
            String saved = prefs.getString(KEY_URL, null);
            loadRemote(saved == null || saved.isEmpty() ? defaultServer() : saved);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
    }

    @Override
    protected void onDestroy() {
        // 本机服务器归 LocalServerService 管，界面销毁不停它：回来时重连同一局
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ---- 返回键 ----------------------------------------------------------------------------------------------------

    /** 返回键：弹「切换服务器 / 退出」。元素全屏时先让页面退出全屏（Chrome 也会自己先吃掉一次返回键）。 */
    private void showExitDialog() {
        if (customView != null && web != null) {
            web.evaluateJavascript("document.exitFullscreen && document.exitFullscreen()", null);
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.dialog_title)
                .setPositiveButton(R.string.dialog_change, (d, w) -> showSetup(""))
                .setNeutralButton(R.string.dialog_exit, (d, w) -> finish())
                .setNegativeButton(R.string.dialog_cancel, null)
                .show();
    }

    /** 未启用预测性返回的系统（API 33 以下，或以后显式关掉该行为）走这里。 */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        showExitDialog();
    }

    // ---- 两种来源 --------------------------------------------------------------------------------------------------

    /** 默认服务器：res/values/strings.xml 的 default_server（可以不带协议）。 */
    private String defaultServer() {
        String url = normalize(getString(R.string.default_server));
        return url != null ? url : "http://127.0.0.1:3000";
    }

    /**
     * 离线版：解压内置游戏文件 → 启动本机服务器（前台服务 {@link LocalServerService}）→ 加载 127.0.0.1。
     * 服务器已经在跑（切后台回来、界面被重建）就直接加载，页面用保存的令牌重连原来的对局。
     */
    private void startLocal() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_MODE, "local").apply();
        // Android 13+ 不授权通知时前台服务照常运行，只是通知栏里看不到它和「停止」按钮
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        showMessage(getString(R.string.local_starting));
        new Thread(() -> {
            try {
                if (LocalRuntime.healthy(LOCAL_PORT)) {
                    Log.i(TAG, "local server already running");
                } else {
                    new LocalRuntime().prepare(this, message -> runOnUiThread(() -> {
                        if (!isFinishing()) showMessage(message);
                    }));
                    runOnUiThread(() -> {
                        if (!isFinishing()) showMessage(getString(R.string.local_starting));
                    });
                    LocalServerService.start(this, LOCAL_PORT);
                    if (!LocalRuntime.waitHealthy(LOCAL_PORT, 90000)) {
                        String why = LocalServerService.failure();
                        throw new IllegalStateException(why != null ? why : "healthz timeout");
                    }
                }
                Log.i(TAG, "local server ready");
                runOnUiThread(() -> {
                    if (!isFinishing()) loadUrl("http://127.0.0.1:" + LOCAL_PORT + "/");
                });
            } catch (final Exception e) {
                final String message = e.getMessage() == null ? e.toString() : e.getMessage();
                Log.w(TAG, "local server failed: " + message);
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_MODE).apply();
                    showSetup(getString(R.string.local_failed, message));
                });
            }
        }, "local-server").start();
    }

    private void loadRemote(String base) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(KEY_MODE, "remote").putString(KEY_URL, base).apply();
        currentUrl = base;
        showMessage(getString(R.string.connecting, base));
        new Thread(() -> {
            final Probe result = probe(base);
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (result == null) {
                    loadUrl(base + "/");
                } else {
                    showError(base, result.detail, result.force);
                }
            });
        }, "probe").start();
    }

    /**
     * 连接前先问一句 /healthz（server/http/routes.js 的健康端点），是这个游戏的服务器才继续。
     * 返回 null 表示正常；否则给出要显示的问题，force 决定是否允许「仍然打开」。
     */
    private Probe probe(String base) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + "/healthz").openConnection();
            connection.setConnectTimeout(6000);
            connection.setReadTimeout(6000);
            connection.setRequestProperty("Accept", "application/json");
            int code = connection.getResponseCode();
            String body = readUpTo(connection, code, 8192);
            if (code == 200 && body.contains("\"app\"")) return null;
            Log.w(TAG, "probe: not a game server (HTTP " + code + ")");
            return new Probe(getString(R.string.probe_not_game), true);
        } catch (Exception e) {
            String message = e.getMessage() == null ? e.toString() : e.getMessage();
            Log.w(TAG, "probe failed: " + message);
            return new Probe(message, false);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readUpTo(HttpURLConnection connection, int code, int limit) {
        InputStream stream = null;
        try {
            stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) return "";
            StringBuilder out = new StringBuilder();
            byte[] buffer = new byte[2048];
            int count;
            while (out.length() < limit && (count = stream.read(buffer)) > 0) {
                out.append(new String(buffer, 0, count, "UTF-8"));
            }
            return out.toString();
        } catch (Exception e) {
            return "";
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                    // 读失败时关闭异常可忽略
                }
            }
        }
    }

    /** probe 的结果：detail 显示在错误页，force 决定是否给出「仍然打开」。 */
    private static final class Probe {
        final String detail;
        final boolean force;

        Probe(String detail, boolean force) {
            this.detail = detail;
            this.force = force;
        }
    }

    // ---- 四个界面：游戏 / 切换服务器 / 连不上 / 提示 ----------------------------------------------------------------

    private void loadUrl(String url) {
        Log.i(TAG, "load " + url);
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        customView = null;
        root.removeAllViews();
        web = createWebView();
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        web.loadUrl(url);
        applyImmersive();
    }

    private void showSetup(String status) {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        customView = null;
        root.removeAllViews();
        View view = getLayoutInflater().inflate(R.layout.setup, root, false);
        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        final EditText input = view.findViewById(R.id.setup_url);
        final TextView statusView = view.findViewById(R.id.setup_status);
        input.setText(stripScheme(currentUrl != null ? currentUrl : defaultServer()));
        statusView.setText(status == null ? "" : status);

        view.findViewById(R.id.setup_connect).setOnClickListener(b -> {
            String url = normalize(input.getText().toString());
            if (url == null) {
                statusView.setText(R.string.setup_bad_url);
                return;
            }
            statusView.setText(getString(R.string.setup_connecting, url));
            loadRemote(url);
        });
        view.findViewById(R.id.setup_reset).setOnClickListener(
                b -> input.setText(stripScheme(defaultServer())));

        View localRow = view.findViewById(R.id.setup_local_row);
        if (LocalRuntime.available(this)) {
            localRow.setVisibility(View.VISIBLE);
            view.findViewById(R.id.setup_local).setOnClickListener(b -> startLocal());
        } else {
            localRow.setVisibility(View.GONE);
        }
        applyImmersive();
    }

    /** 主框架加载失败、或地址不是游戏服务器时显示的页面。force 时额外给出「仍然打开」。 */
    private void showError(String url, String detail, boolean force) {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        customView = null;
        root.removeAllViews();
        View view = getLayoutInflater().inflate(R.layout.error, root, false);
        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        ((TextView) view.findViewById(R.id.error_title)).setText(force
                ? getString(R.string.error_title_foreign, url)
                : getString(R.string.error_title, url));
        TextView code = view.findViewById(R.id.error_code);
        if (detail == null || detail.isEmpty()) {
            code.setVisibility(View.GONE);
        } else {
            code.setText(getString(R.string.error_code, detail));
        }
        final String target = url;
        view.findViewById(R.id.error_retry).setOnClickListener(b -> loadRemote(target));
        view.findViewById(R.id.error_switch).setOnClickListener(b -> showSetup(""));
        View forceButton = view.findViewById(R.id.error_force);
        if (force) {
            forceButton.setVisibility(View.VISIBLE);
            forceButton.setOnClickListener(b -> loadUrl(target + "/"));
        } else {
            forceButton.setVisibility(View.GONE);
        }
        applyImmersive();
    }

    /** 一屏居中提示（解压素材、启动本机服务器时用）。 */
    private void showMessage(String text) {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        customView = null;
        root.removeAllViews();
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(Color.parseColor("#C7D3CE"));
        view.setTextSize(15f);
        view.setGravity(android.view.Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        view.setPadding(pad, pad, pad, pad);
        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        applyImmersive();
    }

    // ---- WebView ---------------------------------------------------------------------------------------------------

    private WebView createWebView() {
        WebView view = new WebView(this);
        view.setBackgroundColor(Color.BLACK);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);                    // 显示设置、术语偏好、重连信息存在 localStorage
        settings.setMediaPlaybackRequiresUserGesture(false);    // BGM / 语音 / 音效不要求先点一下
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // 没有能处理该 scheme 的应用：留在页面里即可
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                String detail = error.getDescription() == null ? "" : error.getDescription().toString();
                Log.w(TAG, "load failed: " + detail);
                String target = currentUrl;
                root.post(() -> showError(target, detail, false));   // 不在回调里销毁 WebView
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest request, WebResourceResponse response) {
                if (!request.isForMainFrame()) return;
                String detail = "HTTP " + response.getStatusCode();
                Log.w(TAG, "http error: " + detail);
                String target = currentUrl;
                root.post(() -> showError(target, detail, true));
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            // 游戏按 Fullscreen API 请求全屏（public/js/ui/device.js）：不实现这两个回调，按钮点了不会有反应。
            @Override
            public void onShowCustomView(View custom, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = custom;
                customViewCallback = callback;
                root.addView(customView, new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
                applyImmersive();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
                applyImmersive();
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(TAG, "console " + message.messageLevel() + ": " + message.message()
                        + " @" + message.lineNumber());
                return true;
            }
        });
        return view;
    }

    // ---- 全屏 ------------------------------------------------------------------------------------------------------

    private void applyImmersive() {
        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(android.view.WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                legacyImmersive();
            }
        } else {
            legacyImmersive();
        }
    }

    @SuppressWarnings("deprecation")
    private void legacyImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    // ---- 地址解析 --------------------------------------------------------------------------------------------------

    /** 接受 `192.168.1.5:3000`、`http://host:3000`、`https://x.trycloudflare.com`；返回不带尾斜杠的基地址。 */
    static String normalize(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        String scheme = "http://";
        if (value.startsWith("https://")) {
            scheme = "https://";
            value = value.substring("https://".length());
        } else if (value.startsWith("http://")) {
            value = value.substring("http://".length());
        } else if (value.contains("://")) {
            return null;
        }
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        if (value.isEmpty() || value.contains("/") || value.contains(" ")) return null;
        int colon = value.indexOf(':');
        String host = colon >= 0 ? value.substring(0, colon) : value;
        if (host.isEmpty() || host.startsWith(".") || host.endsWith(".")) return null;
        if (colon >= 0) {
            try {
                int port = Integer.parseInt(value.substring(colon + 1));
                if (port < 1 || port > 65535) return null;
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return scheme + value;
    }

    /** 设置页回填时去掉协议前缀，只显示主机与端口。 */
    static String stripScheme(String url) {
        if (url == null) return "";
        if (url.startsWith("https://")) return url.substring("https://".length());
        if (url.startsWith("http://")) return url.substring("http://".length());
        return url;
    }
}
