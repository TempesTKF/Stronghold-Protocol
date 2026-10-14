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
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.window.OnBackInvokedDispatcher;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 单 Activity 外壳：沉浸式横屏 WebView 加载上游客户端。
 *
 * 两种模式：
 *   remote  加载用户填写的服务器地址（局域网 IP / 公网域名）——客户端与素材都由该服务器分发，
 *           与在手机浏览器里打开同一地址完全一致，版本检查天然一致（net.js 回连页面所在 host）。
 *   local   启动手机自带的 Node 服务器（可选运行时，见 LocalRuntime），加载 127.0.0.1。
 *
 * 上游没有任何改动；全屏按钮对接 WebChromeClient.onShowCustomView（游戏用 Fullscreen API）。
 */
public final class MainActivity extends Activity {

    private static final String TAG = "StrongholdShell";
    private static final String PREFS = "shell";
    private static final String KEY_MODE = "mode";
    private static final String KEY_URL = "remoteUrl";
    private static final int LOCAL_PORT = 3000;

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private final LocalRuntime local = new LocalRuntime();

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
        String url = prefs.getString(KEY_URL, null);
        if ("local".equals(mode)) {
            if (LocalRuntime.available(this)) {
                startLocal();
            } else {
                showSetup(getString(R.string.setup_local_unavailable));
            }
        } else if ("remote".equals(mode) && url != null && !url.isEmpty()) {
            loadRemote(url);
        } else {
            showSetup("");
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
    }

    @Override
    protected void onDestroy() {
        local.stop();
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

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

    // ---- 界面 ------------------------------------------------------------------------------------------------------

    private void showSetup(String status) {
        local.stop();
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        root.removeAllViews();
        View view = getLayoutInflater().inflate(R.layout.setup, root, false);
        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        final EditText input = view.findViewById(R.id.setup_url);
        final TextView statusView = view.findViewById(R.id.setup_status);
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String last = prefs.getString(KEY_URL, null);
        if (last != null) input.setText(stripScheme(last));
        statusView.setText(status == null ? "" : status);

        view.findViewById(R.id.setup_connect).setOnClickListener(b -> {
            String url = normalize(input.getText().toString());
            if (url == null) {
                statusView.setText(R.string.setup_bad_url);
                return;
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_MODE, "remote").putString(KEY_URL, url).apply();
            statusView.setText(getString(R.string.setup_connecting, url));
            loadRemote(url);
        });

        Button localButton = view.findViewById(R.id.setup_local);
        TextView localNote = view.findViewById(R.id.setup_local_note);
        if (LocalRuntime.available(this)) {
            localNote.setVisibility(View.GONE);
            localButton.setEnabled(true);
            localButton.setOnClickListener(b -> {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_MODE, "local").apply();
                startLocal();
            });
        } else {
            localButton.setEnabled(false);
            localNote.setVisibility(View.VISIBLE);
        }
        applyImmersive();
    }

    private void showMessage(String text) {
        root.removeAllViews();
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(Color.parseColor("#F2F5F4"));
        view.setTextSize(15f);
        view.setGravity(Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        view.setPadding(pad, pad, pad, pad);
        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    // ---- 两种模式 ---------------------------------------------------------------------------------------------------

    private void loadRemote(String base) {
        loadUrl(base + "/");
    }

    private void startLocal() {
        showMessage(getString(R.string.setup_local_starting));
        new Thread(() -> {
            try {
                local.start(this, LOCAL_PORT);
                if (!LocalRuntime.waitHealthy(LOCAL_PORT, 30000)) {
                    throw new IllegalStateException("healthz timeout");
                }
                runOnUiThread(() -> loadUrl("http://127.0.0.1:" + LOCAL_PORT + "/"));
            } catch (final Exception e) {
                final String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                runOnUiThread(() -> {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_MODE).apply();
                    showSetup(getString(R.string.setup_local_failed, msg));
                });
            }
        }, "local-server").start();
    }

    private void loadUrl(String url) {
        Log.i(TAG, "load " + url);
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        root.removeAllViews();
        web = createWebView();
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        web.loadUrl(url);
        applyImmersive();
    }

    // ---- WebView ---------------------------------------------------------------------------------------------------

    private WebView createWebView() {
        WebView view = new WebView(this);
        view.setBackgroundColor(Color.BLACK);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);                    // 游戏的显示设置、术语偏好等存在 localStorage
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
