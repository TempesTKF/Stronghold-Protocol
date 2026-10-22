// android-entry.mjs — 离线版手机上的服务端入口（android/tools/stage-game.sh 把它放到游戏目录根，
// LocalRuntime 用 `node android-entry.mjs` 启动）。和 `node server/index.js` 相同，只是把几个保留窗口拉长：
// 手机上只有自己一个玩家，切到后台、锁屏、WebView 重建都会断开 WebSocket，回来时要能接着打同一局。
//
//   emptyRoomMs            房间里没有在线玩家时保留多久（服务器默认 5 分钟，到点解散——单人对局也会被收掉）
//   reconnectWindowMs      断线的会话能恢复多久（默认 10 分钟，过期即视为离开对局）
//   soloReconnectWindowMs  单人对局的恢复窗口（默认取官方 singleReconnectTime，24 小时）
//
// 都设成 20 天：setTimeout 的上限是 2^31-1 ms（约 24.8 天），超过会被 Node 当成 1 ms 立刻触发。
// 窗口只在本机服务器进程活着时有效；进程被结束（应用退出、系统回收）后对局不会保留。

import { startServer } from './server/index.js';
import { runMain } from './server/http/boot.js';

const KEEP_MS = 20 * 24 * 60 * 60 * 1000;

runMain(() => startServer({
  emptyRoomMs: KEEP_MS,
  reconnectWindowMs: KEEP_MS,
  soloReconnectWindowMs: KEEP_MS,
}));
