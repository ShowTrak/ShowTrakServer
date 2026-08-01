// RemoteDeviceManager
// - Owns the pairing lifecycle for ShowTrak Remote devices (phones/tablets that
//   drive the server over the `/sdk` control API): minting device tokens,
//   verifying them on each handshake, listing them for the settings pane, and
//   revoking them.
// - Also owns the short-lived QR pairing codes, which are the alternative to
//   typing the workspace PIN.
//
// Two secrets with deliberately different lifetimes live here:
//
//   Device token — 32 random bytes, persisted (hashed) and long-lived. This is
//   what a paired phone actually authenticates with. It is long because it is
//   never typed by a human, and persisted because the server is restarted
//   between shows: an operator must not have to re-pair because the desk
//   rebooted mid-show.
//
//   Pairing code — 8 random bytes, in memory, single-use, 60s. This is what the
//   QR code carries. It is short-lived precisely because it is displayed on a
//   screen anyone in the room might see, and single-use so a photograph of the
//   screen is worthless the moment the code is redeemed.
//
// The plaintext device token is returned exactly once, at pairing. Only its
// SHA-256 hash is stored, so a leaked database yields no working credential.
import crypto from 'crypto';

import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateRemoteDevicesRepository } from '../DB/repositories/remote-devices';
import { Manager as UUIDManager } from '../UUID';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type { RemoteDeviceRow } from '../DB/rows';

const Logger = CreateLogger('RemoteDeviceManager');

const RemoteDevicesRepo = CreateRemoteDevicesRepository(DB);

// 32 bytes = 256 bits. Far beyond brute force, and never typed by a human, so
// there is no usability argument for anything shorter.
const TOKEN_BYTES = 32;

// A QR code is read by a camera, not a person, so this only has to survive being
// scanned — 8 bytes keeps the code dense enough to scan reliably at arm's length
// while staying well out of guessing range for its 60-second life.
const PAIRING_CODE_BYTES = 8;

// Long enough to walk from the desk to wherever the phone is, short enough that
// a code left on screen after the operator wanders off is dead before it matters.
const PAIRING_CODE_TTL_MS = 60 * 1000;

// A device name is attacker-controlled text that gets rendered in the settings
// list, so it is clamped on the way in rather than trusted at the point of use.
const MAX_DEVICE_NAME_LENGTH = 64;

/** Platforms a pairing device may declare. Advisory — used only for the icon. */
const KNOWN_PLATFORMS = new Set(['ios', 'android']);

/** A paired device as the settings pane sees it. Never carries the token. */
export interface RemoteDeviceView {
  DeviceID: string;
  DeviceName: string;
  Platform: string | null;
  PairedAt: number;
  LastSeenAt: number | null;
}

/** The one and only time a caller sees a plaintext device token. */
export interface PairingResult {
  DeviceID: string;
  DeviceToken: string;
}

// Live QR pairing codes, keyed by code. In memory by design: a code that does not
// survive a restart is a code an attacker cannot redeem after one, and the
// operator can always display a fresh one.
const PairingCodes = new Map<string, number>();

function HashToken(Token: string): string {
  return crypto.createHash('sha256').update(Token, 'utf8').digest('hex');
}

// Strip control characters (which would corrupt the settings list rendering) and
// clamp the length. An empty result falls back rather than storing a blank row,
// so every device is identifiable in the revoke list.
function SanitizeDeviceName(Name: unknown): string {
  const Raw = typeof Name === 'string' ? Name : '';
  // eslint-disable-next-line no-control-regex
  const Cleaned = Raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!Cleaned) return 'Unnamed Device';
  return Cleaned.slice(0, MAX_DEVICE_NAME_LENGTH);
}

function SanitizePlatform(Platform: unknown): string | null {
  const Raw = typeof Platform === 'string' ? Platform.trim().toLowerCase() : '';
  return KNOWN_PLATFORMS.has(Raw) ? Raw : null;
}

function ToView(Row: RemoteDeviceRow): RemoteDeviceView {
  return {
    DeviceID: Row.DeviceID,
    DeviceName: Row.DeviceName || 'Unnamed Device',
    Platform: Row.Platform,
    PairedAt: Row.PairedAt,
    LastSeenAt: Row.LastSeenAt,
  };
}

// Drop codes that have lapsed. Swept lazily on each issue/redeem rather than on a
// timer, so the map stays bounded to live codes without keeping a handle alive.
function SweepPairingCodes(Now: number): void {
  for (const [Code, ExpiresAt] of PairingCodes) {
    if (ExpiresAt <= Now) PairingCodes.delete(Code);
  }
}

const Manager = {
  /**
   * Issue a single-use pairing code for display as a QR. Any previously issued
   * code is discarded: the pane only ever shows one QR, so keeping older codes
   * alive would widen the window for no benefit.
   */
  IssuePairingCode(): { Code: string; ExpiresAt: number } {
    const Now = Date.now();
    PairingCodes.clear();
    const Code = crypto.randomBytes(PAIRING_CODE_BYTES).toString('hex');
    const ExpiresAt = Now + PAIRING_CODE_TTL_MS;
    PairingCodes.set(Code, ExpiresAt);
    return { Code, ExpiresAt };
  },

  /** Discard every live pairing code (the settings pane closing, or a manual cancel). */
  ClearPairingCodes(): void {
    PairingCodes.clear();
  },

  /**
   * Redeem a pairing code. Single-use: a valid code is deleted before this
   * returns, so two devices racing the same QR cannot both pair.
   */
  RedeemPairingCode(Code: unknown): boolean {
    const Now = Date.now();
    SweepPairingCodes(Now);
    const Presented = typeof Code === 'string' ? Code : '';
    if (!Presented) return false;
    const ExpiresAt = PairingCodes.get(Presented);
    if (ExpiresAt === undefined) return false;
    PairingCodes.delete(Presented);
    return ExpiresAt > Now;
  },

  /**
   * Mint and persist a new device token. The caller is responsible for having
   * already authorised the pairing (PIN checked, or code redeemed, or protection
   * disabled) — this method does not decide who may pair.
   */
  async Pair(DeviceName: unknown, Platform: unknown): Promise<Result<PairingResult>> {
    const DeviceID = UUIDManager.Generate();
    const DeviceToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const [Err] = await RemoteDevicesRepo.Insert(
      DeviceID,
      HashToken(DeviceToken),
      SanitizeDeviceName(DeviceName),
      SanitizePlatform(Platform),
      Date.now()
    );
    if (Err) {
      Logger.error('Failed to persist a paired device:', Err);
      return Fail('Failed to pair device');
    }
    Logger.log('Paired a new Remote device', { DeviceID });
    return Ok({ DeviceID, DeviceToken });
  },

  /**
   * Resolve a presented device token to its device, refreshing LastSeenAt.
   * Returns null for an unknown or revoked token — the caller turns that into a
   * distinguishable handshake error so the app can drop its stored token and
   * re-prompt, rather than retrying a credential that will never work again.
   */
  async Verify(Token: unknown): Promise<RemoteDeviceView | null> {
    const Presented = typeof Token === 'string' ? Token.trim() : '';
    if (!Presented) return null;
    const [Err, Row] = await RemoteDevicesRepo.GetByTokenHash(HashToken(Presented));
    if (Err || !Row) return null;
    // Best-effort: a failed timestamp write must not cost a legitimate device its
    // session. The column is only ever read by the settings pane.
    const [TouchErr] = await RemoteDevicesRepo.TouchLastSeen(Row.DeviceID, Date.now());
    if (TouchErr) Logger.warn('Failed to update device LastSeenAt:', TouchErr);
    return ToView(Row);
  },

  async GetAll(): Promise<Result<RemoteDeviceView[]>> {
    const [Err, Rows] = await RemoteDevicesRepo.GetAll();
    if (Err) return Fail('Failed to read paired devices');
    return Ok((Rows || []).map(ToView));
  },

  async Revoke(DeviceID: unknown): Promise<Result<string>> {
    const ID = typeof DeviceID === 'string' ? DeviceID.trim() : '';
    if (!ID) return Fail('No device specified');
    const [Err] = await RemoteDevicesRepo.Delete(ID);
    if (Err) return Fail('Failed to revoke device');
    Logger.log('Revoked a Remote device', { DeviceID: ID });
    return Ok(ID);
  },

  async RevokeAll(): Promise<Result<null>> {
    const [Err] = await RemoteDevicesRepo.DeleteAll();
    if (Err) return Fail('Failed to revoke devices');
    Logger.log('Revoked every Remote device.');
    return Ok(null);
  },
};

export { Manager, HashToken, SanitizeDeviceName, SanitizePlatform, PAIRING_CODE_TTL_MS };
