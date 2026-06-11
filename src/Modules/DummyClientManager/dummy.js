// DummyClient
// Runtime representation of a single virtual client. Unlike a real client there
// is no socket connection: liveness is driven entirely by external heartbeats
// delivered over OSC or HTTP. Each dummy owns a watchdog timer that is reset on
// every heartbeat. When the watchdog fires the dummy first goes Degraded
// ("Missed Heartbeat") and, on a second consecutive miss, Offline.
//
// State machine:
//   IDLE      -> (first heartbeat) -> ONLINE
//   ONLINE    -> (heartbeat)       -> ONLINE
//   ONLINE    -> (missed)          -> DEGRADED (Missed Heartbeat)
//   DEGRADED  -> (heartbeat)       -> ONLINE
//   DEGRADED  -> (missed again)    -> OFFLINE
//   OFFLINE   -> (heartbeat)       -> ONLINE
//
// Only ONLINE/DEGRADED keep the watchdog armed. IDLE and OFFLINE sit quietly
// until the next heartbeat arrives.
const { Manager: BroadcastManager } = require('../Broadcast');
const { ClampInterval } = require('./normalize');

const STATE_IDLE = 'IDLE';
const STATE_ONLINE = 'ONLINE';
const STATE_DEGRADED = 'DEGRADED';
const STATE_OFFLINE = 'OFFLINE';

const MISSED_HEARTBEAT_REASON = 'Missed Heartbeat';

class DummyClient {
  constructor(Row) {
    this.UUID = Row.UUID;
    this.DummyID = Row.DummyID;
    this.Nickname = Row.Nickname || '';
    this.Interval = ClampInterval(Row.Interval);
    this.IP = Row.IP || null;
    this.GroupID = Row.GroupID == null ? null : Row.GroupID;
    this.Weight = typeof Row.Weight === 'number' ? Row.Weight : 100;
    this.Timestamp = Row.Timestamp;

    // RAM-only runtime state. A freshly loaded dummy always starts Idle until a
    // heartbeat arrives, mirroring how a real client is offline after a restart.
    this.State = STATE_IDLE;
    this.Online = false;
    this.Degraded = false;
    this.DegradedWarnings = [];
    this.LastSeen = null;
    this.MissedCount = 0;
    this._timer = null;
  }

  // Snapshot used for IPC + broadcast payloads. Shaped so the existing client
  // UI (and the client alert handler) can consume it directly.
  ToJSON() {
    return {
      UUID: this.UUID,
      DummyID: this.DummyID,
      Nickname: this.Nickname,
      // Hostname/Version are surfaced for compatibility with code paths that
      // expect a client-like shape; the UI shows the literal "Dummy" label.
      // IP is the source address of the most recent heartbeat (OSC or HTTP).
      Hostname: this.Nickname,
      IP: this.IP,
      Version: 'Dummy',
      Interval: this.Interval,
      GroupID: this.GroupID,
      Weight: this.Weight,
      Timestamp: this.Timestamp,
      State: this.State,
      Online: this.Online,
      Degraded: this.Degraded,
      DegradedWarnings: this.DegradedWarnings.slice(),
      LastSeen: this.LastSeen,
      Type: 'dummy',
    };
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _armWatchdog() {
    this._clearTimer();
    this._timer = setTimeout(() => this._onWatchdog(), this.Interval);
  }

  // Called when the watchdog fires (a heartbeat window elapsed without one).
  _onWatchdog() {
    this._timer = null;
    this.MissedCount += 1;
    if (this.MissedCount >= 2) {
      // Second consecutive miss -> Offline. Stop the watchdog; the dummy will
      // re-arm it the next time a heartbeat is received.
      this.State = STATE_OFFLINE;
      this.Online = false;
      this.Degraded = false;
      this.DegradedWarnings = [];
    } else {
      // First miss -> Degraded but still considered online.
      this.State = STATE_DEGRADED;
      this.Online = true;
      this.Degraded = true;
      this.DegradedWarnings = [MISSED_HEARTBEAT_REASON];
      this._armWatchdog();
    }
    BroadcastManager.emit('DummyClientUpdated', this.ToJSON());
  }

  // External heartbeat received (OSC or HTTP). Resets the dummy to Online.
  // When a source IP is supplied it is recorded as the dummy's current IP.
  Heartbeat(IP = null) {
    const Now = Date.now();
    if (IP) this.IP = IP;
    this.MissedCount = 0;
    this.State = STATE_ONLINE;
    this.Online = true;
    this.Degraded = false;
    this.DegradedWarnings = [];
    this.LastSeen = Now;
    this._armWatchdog();
    BroadcastManager.emit('DummyClientUpdated', this.ToJSON());
  }

  // Apply a new interval at runtime. If the dummy is currently being watched
  // (Online/Degraded) the watchdog is re-armed against the new interval.
  SetInterval(Interval) {
    this.Interval = ClampInterval(Interval);
    if (this.State === STATE_ONLINE || this.State === STATE_DEGRADED) {
      this._armWatchdog();
    }
  }

  StopLoop() {
    this._clearTimer();
  }
}

module.exports = {
  DummyClient,
  STATE_IDLE,
  STATE_ONLINE,
  STATE_DEGRADED,
  STATE_OFFLINE,
  MISSED_HEARTBEAT_REASON,
};
