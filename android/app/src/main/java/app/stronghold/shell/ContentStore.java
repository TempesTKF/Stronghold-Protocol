package app.stronghold.shell;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 离线版单独导入的内容：素材包与插件（皮肤）包，不在 APK 里。
 *
 * 存在 filesDir/content/{assets,fonts,plugins/<id>}——游戏目录（filesDir/game）在 APK 升级时会整个重新解压，
 * 导入的内容放在它外面，再用软链接进去：game/public/assets、game/public/fonts、game/plugins/<id>。
 * 服务器按普通文件读它们（public/ 的静态文件走 stat，跟随软链；插件目录顶层也是 stat，插件内的文件按
 * 插件目录的真实路径做包含检查，链进来的整个文件夹照样通过）。
 *
 * 一个 zip 里可以同时有两类内容，按条目路径分：
 *   素材：assets/…、fonts/…，或前面带 public/、&lt;任意一层&gt;/public/（完整发布包、setup 产物的布局）；
 *   插件：其余 &lt;文件夹&gt;/… 中带 plugin.json 的文件夹（TKF 的 official-operator-skins.zip 就是 4 个这样的文件夹）。
 */
final class ContentStore {

    private static final String TAG = "StrongholdContent";
    private static final Pattern ART = Pattern.compile("^(?:(?:[^/]+/)?public/)?(assets|fonts)/(.+)$");
    private static final Pattern PLUGIN = Pattern.compile("^([A-Za-z0-9][A-Za-z0-9._-]*)/(.+)$");
    private static final String ART_COUNT = ".art-files";

    interface Progress {
        void onFiles(int written);
    }

    /** 导入结果。 */
    static final class Result {
        int artFiles;
        final List<String> plugins = new ArrayList<>();

        boolean empty() {
            return artFiles == 0 && plugins.isEmpty();
        }
    }

    /** 剩余空间不够。 */
    static final class NoSpace extends IOException {
        final long need;
        final long free;

        NoSpace(long need, long free) {
            super("no space");
            this.need = need;
            this.free = free;
        }
    }

    private ContentStore() {
    }

    static File root(Context context) {
        return new File(context.getFilesDir(), "content");
    }

    private static File assetsDir(Context context) {
        return new File(root(context), "assets");
    }

    private static File fontsDir(Context context) {
        return new File(root(context), "fonts");
    }

    private static File pluginsDir(Context context) {
        return new File(root(context), "plugins");
    }

    /** 已导入的插件（带 plugin.json 的文件夹名）。 */
    static List<String> plugins(Context context) {
        List<String> out = new ArrayList<>();
        File[] dirs = pluginsDir(context).listFiles();
        if (dirs == null) return out;
        for (File dir : dirs) {
            if (new File(dir, "plugin.json").isFile()) out.add(dir.getName());
        }
        java.util.Collections.sort(out);
        return out;
    }

    /** 已导入的素材文件数（导入时记下，不在界面线程里数三万个文件）。 */
    static int artFiles(Context context) {
        try {
            byte[] bytes = Files.readAllBytes(new File(root(context), ART_COUNT).toPath());
            return Integer.parseInt(new String(bytes, "UTF-8").trim());
        } catch (Exception e) {
            return 0;
        }
    }

    // ---- 链进游戏目录 -----------------------------------------------------------------------------------------------

    /** 让游戏目录的 public/assets、public/fonts、plugins/&lt;id&gt; 指向导入的内容（幂等；本机服务器每次启动前调用）。 */
    static void link(Context context) {
        File game = LocalRuntime.gameDir(context);
        if (!new File(game, "server").isDirectory()) return;
        try {
            linkDir(assetsDir(context), new File(game, "public/assets"));
            linkDir(fontsDir(context), new File(game, "public/fonts"));
            File gamePlugins = new File(game, "plugins");
            List<String> imported = plugins(context);
            File[] present = gamePlugins.listFiles();
            if (present != null) {
                for (File entry : present) {
                    // 只动自己建的软链：已经不在导入列表里的（被清除、被替换）删掉
                    if (isLink(entry) && !imported.contains(entry.getName())) entry.delete();
                }
            }
            for (String id : imported) linkDir(new File(pluginsDir(context), id), new File(gamePlugins, id));
        } catch (Exception e) {
            Log.w(TAG, "link failed: " + e);
        }
    }

    /** link 指向 target；target 不存在时删掉旧链接；同名的真实目录（APK 自带的）保持不动。 */
    private static void linkDir(File target, File link) throws Exception {
        boolean isLink = isLink(link);
        if (!target.isDirectory()) {
            if (isLink) link.delete();
            return;
        }
        if (isLink) {
            if (Os.readlink(link.getPath()).equals(target.getPath())) return;
            link.delete();
        } else if (link.exists()) {
            Log.i(TAG, "keep bundled " + link);
            return;
        }
        File parent = link.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdirs " + parent);
        Os.symlink(target.getPath(), link.getPath());
    }

    private static boolean isLink(File file) {
        return Files.isSymbolicLink(file.toPath());
    }

    // ---- 导入 ------------------------------------------------------------------------------------------------------

    /** 从用户选的 zip 导入素材与插件；先解到 content/.incoming，全部写完再移到位，中途失败不留半套。 */
    static Result importZip(Context context, Uri uri, Progress progress) throws IOException {
        File root = root(context);
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("mkdirs " + root);
        long size = zipSize(context, uri);
        long free = root.getUsableSpace();
        // 素材与皮肤多是已压缩格式，解开约为 zip 的 1.4 倍；再留一点余量
        long need = size > 0 ? size * 3 / 2 + (64L << 20) : 0;
        if (need > free) throw new NoSpace(need, free);

        File staging = new File(root, ".incoming");
        if (staging.exists() && !LocalRuntime.deleteTree(staging)) throw new IOException("cannot clean " + staging);
        File stagedArt = new File(staging, "art");
        File stagedPlugins = new File(staging, "plugins");
        String base = staging.getCanonicalPath() + File.separator;
        int written = 0;
        byte[] buffer = new byte[65536];
        try (InputStream raw = context.getContentResolver().openInputStream(uri)) {
            if (raw == null) throw new IOException("cannot open " + uri);
            ZipInputStream zip = new ZipInputStream(raw);
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName().replace('\\', '/');
                if (name.startsWith("/") || name.contains("\0") || ("/" + name + "/").contains("/../")) {
                    throw new IOException("unsafe entry: " + name);
                }
                if (name.startsWith("__MACOSX/")) continue;   // macOS 打包附带的元数据
                File target;
                Matcher art = ART.matcher(name);
                Matcher plugin = PLUGIN.matcher(name);
                if (art.matches()) {
                    target = new File(stagedArt, art.group(1) + "/" + art.group(2));
                } else if (plugin.matches() && !plugin.group(1).startsWith("_")) {
                    target = new File(stagedPlugins, plugin.group(1) + "/" + plugin.group(2));
                } else {
                    continue;   // 顶层散文件（README 等）不要
                }
                // 规则之外再按真实路径确认一次没有跳出暂存目录
                if (!target.getCanonicalPath().startsWith(base)) throw new IOException("unsafe entry: " + name);
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdirs " + parent);
                try (OutputStream out = new FileOutputStream(target)) {
                    int count;
                    while ((count = zip.read(buffer)) > 0) out.write(buffer, 0, count);
                }
                if (++written % 200 == 0 && progress != null) progress.onFiles(written);
            }
        } catch (IOException e) {
            LocalRuntime.deleteTree(staging);
            throw e;
        }

        Result result = new Result();
        // 插件：带 plugin.json 的文件夹整个替换同名的旧版本
        File[] candidates = stagedPlugins.listFiles();
        if (candidates != null) {
            File plugins = pluginsDir(context);
            if (!plugins.isDirectory() && !plugins.mkdirs()) throw new IOException("mkdirs " + plugins);
            for (File dir : candidates) {
                if (!new File(dir, "plugin.json").isFile()) continue;
                File dest = new File(plugins, dir.getName());
                if (dest.exists() && !LocalRuntime.deleteTree(dest)) throw new IOException("cannot replace " + dest);
                if (!dir.renameTo(dest)) throw new IOException("cannot move " + dir);
                result.plugins.add(dir.getName());
            }
        }
        // 素材：逐个文件并入（同名覆盖），一个素材包可以分几次导入
        result.artFiles = merge(new File(stagedArt, "assets"), assetsDir(context))
                + merge(new File(stagedArt, "fonts"), fontsDir(context));
        LocalRuntime.deleteTree(staging);
        if (result.artFiles > 0) {
            int total = countFiles(assetsDir(context)) + countFiles(fontsDir(context));
            try (OutputStream out = new FileOutputStream(new File(root, ART_COUNT))) {
                out.write(String.valueOf(total).getBytes("UTF-8"));
            }
        }
        java.util.Collections.sort(result.plugins);
        Log.i(TAG, "imported " + result.artFiles + " art files, plugins " + result.plugins);
        return result;
    }

    /** 清除导入的全部内容，并拆掉游戏目录里的链接。 */
    static void clear(Context context) {
        LocalRuntime.deleteTree(root(context));
        link(context);
    }

    private static int merge(File from, File into) throws IOException {
        if (!from.isDirectory()) return 0;
        int moved = 0;
        File[] children = from.listFiles();
        if (children == null) return 0;
        for (File child : children) {
            File dest = new File(into, child.getName());
            if (child.isDirectory()) {
                moved += merge(child, dest);
                continue;
            }
            if (!into.isDirectory() && !into.mkdirs()) throw new IOException("mkdirs " + into);
            if (dest.exists() && !dest.delete()) throw new IOException("cannot replace " + dest);
            if (!child.renameTo(dest)) throw new IOException("cannot move " + child);
            moved++;
        }
        return moved;
    }

    private static int countFiles(File dir) {
        File[] children = dir.listFiles();
        if (children == null) return 0;
        int n = 0;
        for (File child : children) n += child.isDirectory() ? countFiles(child) : 1;
        return n;
    }

    private static long zipSize(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[] {OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getLong(0);
        } catch (Exception ignored) {
            // 取不到大小就不预先检查空间
        }
        return -1;
    }

    /** 选中文件的显示名（进度提示用）。 */
    static String displayName(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (Exception ignored) {
            // 用 URI 本身
        }
        return uri.getLastPathSegment();
    }
}
