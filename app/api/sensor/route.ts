import { NextRequest, NextResponse } from 'next/server';
import { detectFall } from '@/lib/detectFall';
import { detectHRSpike } from '@/lib/detectHRSpike';
import twilio from 'twilio';

interface Vec3 { x: number; y: number; z: number; }

interface SensorReading {
  heartRate?: number;
  accelerometer?: Vec3;
  gyroscope?: Vec3;
  fallDetected?: boolean;
  hrAlert?: boolean;
  timestamp?: string;
}

// Module-level in-memory store (resets on server restart)
let latest: SensorReading | null = null;

// Separate cooldowns so a simultaneous fall + HR spike doesn't block either call.
let lastFallCallAt = 0;
let lastHRCallAt   = 0;
const CALL_COOLDOWN_MS = 60_000;

// ── Twilio voice call helper ───────────────────────────────────────────────────
// Silently skips if env vars aren't filled in — app works fine without them.
async function placeCall(message: string, cooldownRef: { ts: number }) {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const to   = process.env.TWILIO_TO;
  if (!sid || !auth || !from || !to) return;

  const now = Date.now();
  if (now - cooldownRef.ts < CALL_COOLDOWN_MS) return;
  cooldownRef.ts = now;

  try {
    const client = twilio(sid, auth);
    await client.calls.create({
      twiml: `<Response><Say voice="alice" loop="2">${message}</Say></Response>`,
      from,
      to,
    });
    console.log('[CALL] Alert placed to', to, '—', message.slice(0, 60));
  } catch (err) {
    console.error('[CALL] Failed:', err);
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────
export async function GET() {
  if (!latest) {
    return NextResponse.json({ error: 'No reading available yet' }, { status: 404 });
  }
  return NextResponse.json(latest);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  const reading   = body as SensorReading;
  const timestamp = new Date().toISOString();

  // ── Fall detection ──────────────────────────────────────────────────────────
  // Server-side algorithm is authoritative when IMU data is present.
  // Client-sent fallDetected is trusted only when no IMU data arrives (demo mode).
  let fallDetected = reading.fallDetected ?? false;
  if (reading.accelerometer && reading.gyroscope) {
    fallDetected = detectFall(reading.accelerometer, reading.gyroscope) || fallDetected;
  }

  // ── HR spike detection ──────────────────────────────────────────────────────
  // Server-side algorithm is authoritative when IMU data is present.
  // Client-sent hrAlert is trusted only when no IMU data arrives (demo mode),
  // mirroring the same pattern used for fallDetected above.
  const hrAlert = (reading.accelerometer && reading.gyroscope)
    ? detectHRSpike(reading.heartRate ?? 0)
    : (reading.hrAlert ?? detectHRSpike(reading.heartRate ?? 0));

  latest = { ...reading, fallDetected, hrAlert, timestamp };

  // Fire-and-forget calls — don't await so the ESP32 POST returns in < 10ms.
  const fallRef = { ts: lastFallCallAt };
  const hrRef   = { ts: lastHRCallAt };

  if (fallDetected) {
    placeCall(
      `Warning. Fall detected at ${new Date(timestamp).toLocaleTimeString()}. Please check on the patient immediately.`,
      fallRef,
    ).then(() => { lastFallCallAt = fallRef.ts; });
  }

  if (hrAlert) {
    placeCall(
      `Warning. Elevated heart rate detected. Current reading is ${reading.heartRate} beats per minute. Please check on the patient.`,
      hrRef,
    ).then(() => { lastHRCallAt = hrRef.ts; });
  }

  return NextResponse.json({ ok: true, fallDetected, hrAlert, timestamp }, { status: 201 });
}
