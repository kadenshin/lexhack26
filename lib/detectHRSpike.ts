/**
 * Heart-rate spike detection — sustained threshold approach.
 *
 * A single noisy reading can briefly show 130 BPM even on a normal person.
 * Requiring SUSTAINED_READINGS consecutive readings above the threshold
 * before alerting eliminates single-sample false positives.
 *
 * Thresholds
 * ──────────
 * ALERT_BPM (120)          — "Elevated" zone. Resting HR above 120 bpm is
 *                            clinically notable (normal resting max ≈ 100).
 *                            Lower to 110 if patients are sedentary/elderly;
 *                            raise to 140 if patients are active/athletes.
 *
 * SUSTAINED_READINGS (4)   — Must stay above ALERT_BPM for this many
 *                            consecutive 500ms polls (= 2 seconds of real
 *                            data) before an alert fires. Raise to 6 (3s)
 *                            to reduce false positives from brief movement.
 *
 * COOLDOWN_MS (60_000)     — Only one alert per minute even if HR stays
 *                            elevated. Raise to 120_000 for less noise;
 *                            lower to 30_000 for faster re-alerting.
 */

const ALERT_BPM          = 120;
const SUSTAINED_READINGS = 4;
const COOLDOWN_MS        = 60_000;

let consecutive  = 0;
let lastAlertAt  = 0;

/**
 * Feed one BPM reading.
 * Returns true exactly once per alert event (respects cooldown),
 * then resets so the next sustained spike can be detected independently.
 */
export function detectHRSpike(bpm: number): boolean {
  if (!bpm || bpm <= 0) {
    consecutive = 0; // sensor not ready / finger off
    return false;
  }

  if (bpm >= ALERT_BPM) {
    consecutive++;
  } else {
    consecutive = 0; // HR recovered — require a full new sustained window
  }

  const now = Date.now();
  if (consecutive >= SUSTAINED_READINGS && now - lastAlertAt > COOLDOWN_MS) {
    lastAlertAt = now;
    return true;
  }

  return false;
}

export function resetHRDetector(): void {
  consecutive = 0;
  lastAlertAt = 0;
}
