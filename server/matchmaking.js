// Server-owned FIFO matchmaking: public co-op lobbies of the exact difficulty, then a new room after 30 s.
// Disconnect, cancellation or manually entering a room removes the search; no client timer can create a room.
import { ERR } from '../shared/constants.js';
import { sendSession } from './net.js';

export const MATCH_WAIT_MS = 30_000;

export class Matchmaking {
  constructor(lobby) {
    this.lobby = lobby;
    this.queue = new Map();
    this.timer = null;
    this.draining = false;
  }

  start(session, difficulty, version = this.lobby.defaultVersion()) {
    if (!this.lobby.versionEnabled(version)) return { error: ERR.VERSION_UNKNOWN };
    if (!this.lobby.versionAvailable(version) || !this.lobby.offered(version, 'coop').length) return { error: ERR.VERSION_UNSUPPORTED };
    difficulty = this.lobby.fallbackDifficulty(version, 'coop', difficulty);
    if (this.lobby.roomOf(session)) return { error: ERR.ALREADY };
    const existing = this.queue.get(session.playerId);
    if (existing) { this.send(existing); return { ok: true }; } // repeated requests never extend the deadline
    const search = { session, difficulty, version, deadlineAt: this.lobby.now() + MATCH_WAIT_MS };
    this.queue.set(session.playerId, search);
    this.send(search);
    this.drain();
    return { ok: true };
  }

  send(search) {
    sendSession(search.session, { t: 'match.state', searching: true, difficulty: search.difficulty,
      deadlineAt: search.deadlineAt, waitMs: MATCH_WAIT_MS });
  }

  cancel(session, reason = 'cancelled') {
    if (!this.queue.delete(session.playerId)) return { ok: true };
    sendSession(session, { t: 'match.state', searching: false, reason });
    if (!this.queue.size) { clearTimeout(this.timer); this.timer = null; }
    return { ok: true };
  }

  findRoom(difficulty, version = this.lobby.defaultVersion()) {
    for (const room of this.lobby.rooms.values()) {
      if (!room.disposed && room.isPublic && room.mode === 'coop' && !room.match &&
          room.version === version && room.difficulty === difficulty && room.freeSeat() >= 0 && room.hasOnlineHumans()) return room;
    }
    return null;
  }

  drain() {
    if (this.draining) return;
    this.draining = true;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      for (const search of this.queue.values()) {
        const { session, difficulty, version, deadlineAt } = search;
        if (!session.connected || this.lobby.registry.byId(session.playerId) !== session || this.lobby.roomOf(session)) {
          this.cancel(session, 'cancelled');
          continue;
        }
        const room = this.findRoom(difficulty, version);
        if (!room && this.lobby.now() < deadlineAt) continue;
        // The room is rechecked and the seat filled synchronously; parallel requests cannot reserve the same slot.
        this.queue.delete(session.playerId);
        const result = room ? this.lobby.join(session, { code: room.code })
          : this.lobby.create(session, { mode: 'coop', difficulty, version });
        sendSession(session, { t: 'match.state', searching: false,
          reason: result.ok ? room ? 'joined' : 'created' : 'failed', ...(result.error ? { error: result.error } : {}) });
      }
    } finally {
      this.draining = false;
      if (this.queue.size) {
        const remaining = Math.min(...[...this.queue.values()].map(s => s.deadlineAt - this.lobby.now()));
        this.timer = setTimeout(() => this.drain(), Math.max(1, Math.min(1000, remaining)));
        this.timer.unref?.();
      }
    }
  }

  shutdown() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const { session } of this.queue.values()) this.cancel(session, 'shutdown');
  }
}
