/**
 * Threshold-based fall detection using a three-phase state machine.
 *
 * Phase 1 – FREE-FALL
 *   Accel magnitude drops below FREE_FALL_G (0.4 g ≈ 3.9 m/s²).
 *   A person in free-fall is briefly weightless, so the IMU reads near 0.
 *   Threshold is set above 0 to tolerate sensor noise.
 *
 * Phase 2 – IMPACT
 *   Within FREE_FALL_WINDOW_MS (500 ms) of entering free-fall,
 *   accel magnitude spikes above IMPACT_G (2.0 g ≈ 19.6 m/s²).
 *   Normal walking peaks at ~1.5 g; a real impact is well above that.
 *   The 500 ms window prevents random high-G arm gestures (not preceded
 *   by free-fall) from triggering detection.
 *
 * Phase 3 – POST-FALL CHECK
 *   Within POST_FALL_WINDOW_MS (2000 ms) of impact, gyroscope magnitude
 *   falls below STILLNESS_RAD_S (0.5 rad/s ≈ 28 °/s).
 *   After a real fall the body either lies still or moves very slowly.
 *   This phase filters out impacts that are followed by continued motion
 *   (e.g., bumping a table, high-impact sports moves).
 *
 * State resets to NORMAL on timeout at each phase, or after a detection.
 * Module-level state is intentional: one device stream, one server process.
 */

interface Vec3 { x: number; y: number; z: number; }

// ─── Thresholds ────────────────────────────────────────────────────────────

/** Accel magnitude below this → free-fall suspected  (m/s², ~0.4 g)
 *  Raise toward 6.0 to catch slower stumbles; lower toward 2.0 to require
 *  a more dramatic drop (fewer false positives from quick arm dips). */
const FREE_FALL_THRESHOLD = 3.9;

/** Accel magnitude above this → impact detected       (m/s², ~1.5 g)
 *  Lowered from 19.6 (2 g) — wrist-worn devices see softer impacts than
 *  waist-worn ones. Raise toward 25 if walking/running triggers false alerts. */
const IMPACT_THRESHOLD = 15.0;

/** Gyro magnitude below this → body is still          (rad/s, ~28 °/s)
 *  Raise toward 1.0 if falls aren't confirmed (person still moving after hit);
 *  lower toward 0.2 to require complete stillness. */
const STILLNESS_THRESHOLD = 0.5;

/** Max time between free-fall onset and impact         (ms)
 *  Must be > one sensor polling interval. ESP32 posts every 500 ms, so 500 ms
 *  allowed only one reading in free-fall. 1000 ms gives 2 readings of headroom. */
const FREE_FALL_WINDOW_MS = 1000;

/** Window after impact to observe post-fall stillness  (ms)
 *  Raise toward 3000 if confirmed falls are missed (person takes longer to stop);
 *  lower toward 1000 to reset faster between events. */
const POST_FALL_WINDOW_MS = 2000;

// ─── State ─────────────────────────────────────────────────────────────────

type Phase = 'normal' | 'free_fall' | 'impact';

let phase: Phase = 'normal';
let phaseStartedAt = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────

function mag(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Feed one IMU reading. Returns true exactly once per detected fall event,
 * then resets internal state so the next fall can be detected independently.
 */
export function detectFall(accel: Vec3, gyro: Vec3): boolean {
  const accelMag = mag(accel);
  const gyroMag  = mag(gyro);
  const now      = Date.now();

  switch (phase) {
    case 'normal':
      if (accelMag < FREE_FALL_THRESHOLD) {
        phase = 'free_fall';
        phaseStartedAt = now;
      }
      break;

    case 'free_fall':
      if (now - phaseStartedAt > FREE_FALL_WINDOW_MS) {
        // Impact never came — was probably just a quick dip, reset.
        phase = 'normal';
      } else if (accelMag > IMPACT_THRESHOLD) {
        phase = 'impact';
        phaseStartedAt = now;
      }
      break;

    case 'impact':
      if (now - phaseStartedAt > POST_FALL_WINDOW_MS) {
        // No stillness observed — movement continued, not a fall.
        phase = 'normal';
      } else if (gyroMag < STILLNESS_THRESHOLD) {
        // Body stopped rotating after impact → confirmed fall.
        phase = 'normal';
        return true;
      }
      break;
  }

  return false;
}

/** Expose current phase for debugging / unit tests. */
export function currentPhase(): Phase { return phase; }

/** Reset state (useful for tests or device reconnect). */
export function resetDetector(): void {
  phase = 'normal';
  phaseStartedAt = 0;
}
