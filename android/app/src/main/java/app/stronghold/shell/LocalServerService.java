package app.stronghold.shell;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 离线版的本机服务器：前台服务持有 node 进程。
 *
 * 进程放在 Activity 里时，Activity 一销毁（返回键退出、系统回收界面、换配置）服务器就跟着没了，正在打的
 * 对局随之丢失；切到后台的应用还会被系统冻结或优先回收。前台服务让进程在后台继续活着，回到应用时
 * WebView 用 localStorage 里的令牌重连（public/js/net.js），android-entry.mjs 又把房间与断线会话的
 * 保留窗口拉到 20 天——两者合起来，离线对局可以随时回来接着打。
 *
 * 只有「退出」（对话框或通知上的按钮）会停掉服务器；划掉最近任务不停。
 */
public final class LocalServerService extends Service {

    private static final String TAG = "StrongholdNode";
    private static final String CHANNEL = "local-server";
    private static final int NOTIFICATION_ID = 1;
    static final String ACTION_STOP = "app.stronghold.shell.action.STOP_LOCAL";
    static final String EXTRA_PORT = "port";

    private static volatile String failure;
    private final LocalRuntime runtime = new LocalRuntime();
    private volatile Thread worker;
    private volatile boolean stopping;

    /** 最近一次启动失败或进程意外退出的原因；正常运行时为 null。 */
    static String failure() {
        return failure;
    }

    static void start(Context context, int port) {
        failure = null;
        Intent intent = new Intent(context, LocalServerService.class).putExtra(EXTRA_PORT, port);
        context.startForegroundService(intent);
    }

    static void stop(Context context) {
        context.startService(new Intent(context, LocalServerService.class).setAction(ACTION_STOP));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            shutdown();
            return START_NOT_STICKY;
        }
        // startForegroundService 之后必须尽快 startForeground，否则系统会结束应用
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        if (worker == null) {
            stopping = false;
            final int port = intent == null ? 3000 : intent.getIntExtra(EXTRA_PORT, 3000);
            worker = new Thread(() -> run(port), "local-server");
            worker.start();
        }
        // 被系统回收后不自动重启：重启的是一个空服务器，对局本来就回不来，留给用户下次打开时再起
        return START_NOT_STICKY;
    }

    /** 启动 node 并等它退出；意外退出时记下原因、结束服务（下次打开应用会重新起）。 */
    private void run(int port) {
        try {
            Process process = runtime.start(this, port);
            int code = process.waitFor();
            Log.w(TAG, "node exited: " + code);
            if (!stopping) {
                // 输出由 drain 线程读，进程退出后稍等它读完最后几行
                Thread.sleep(300);
                String output = runtime.outputTail();
                failure = "node exited (" + code + ")" + (output.isEmpty() ? "" : "\n" + output);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            failure = e.getMessage() == null ? e.toString() : e.getMessage();
            Log.w(TAG, "node start failed: " + failure);
        }
        // 被 shutdown() 停掉（或已换了新线程）时由那边收尾
        if (worker != Thread.currentThread()) return;
        worker = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void shutdown() {
        Log.i(TAG, "stop requested");
        stopping = true;
        Thread running = worker;
        worker = null;
        runtime.stop();
        if (running != null) running.interrupt();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        runtime.stop();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL, getString(R.string.local_channel), NotificationManager.IMPORTANCE_LOW));
        }
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, LocalServerService.class).setAction(ACTION_STOP), flags);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(getString(R.string.local_notification_title))
                .setContentText(getString(R.string.local_notification_text))
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder((android.graphics.drawable.Icon) null, getString(R.string.local_notification_stop), stop).build())
                .build();
    }
}
