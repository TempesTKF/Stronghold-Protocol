package app.stronghold.shell;

/**
 * 构建模式。装在源码树里的这份是默认（联机版）；`MODE=offline bash android/build.sh` 会在
 * build/gen-src 生成同名类的另一份（{@code OFFLINE = true}）并把它排除在编译之外，
 * 所以两个版本的 Java 代码只有这一个常量不同。
 *
 * 联机版（OFFLINE=false）：连玩家填的服务器（不内置默认地址）；没有内置运行时，本地模式不可用。
 * 离线版（OFFLINE=true）：默认本地开服（内置 Node 运行时与游戏文件），也能切换去连服务器。
 */
public final class BuildMode {

    public static final boolean OFFLINE = false;

    private BuildMode() {
    }
}
