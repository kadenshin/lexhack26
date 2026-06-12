'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Vec3 { x: number; y: number; z: number; }

interface SensorData {
  heartRate: number;
  accelerometer: Vec3;
  gyroscope: Vec3;
}

// ─── Mock data ────────────────────────────────────────────────────────────────

const INITIAL: SensorData = {
  heartRate: 72,
  accelerometer: { x: 0.02, y: -0.05, z: 9.81 },
  gyroscope: { x: 0.001, y: -0.002, z: 0.003 },
};

function nextData(prev: SensorData): SensorData {
  return {
    heartRate: Math.round(Math.max(45, Math.min(165, prev.heartRate + (Math.random() - 0.5) * 8))),
    accelerometer: {
      x: parseFloat((prev.accelerometer.x + (Math.random() - 0.5) * 0.4).toFixed(2)),
      y: parseFloat((prev.accelerometer.y + (Math.random() - 0.5) * 0.4).toFixed(2)),
      z: parseFloat((9.81 + (Math.random() - 0.5) * 0.2).toFixed(2)),
    },
    gyroscope: {
      x: parseFloat(((Math.random() - 0.5) * 1.5).toFixed(3)),
      y: parseFloat(((Math.random() - 0.5) * 1.5).toFixed(3)),
      z: parseFloat(((Math.random() - 0.5) * 1.5).toFixed(3)),
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type HRStatus = { label: string; color: string; ring: string; };

function hrStatus(bpm: number): HRStatus {
  if (bpm < 60) return { label: 'Low',    color: 'text-sky-400',     ring: '#38bdf8' };
  if (bpm <= 100) return { label: 'Normal', color: 'text-emerald-400', ring: '#34d399' };
  return              { label: 'High',   color: 'text-rose-400',    ring: '#fb7185' };
}

const AXIS_STYLE = {
  x: { bar: 'bg-rose-500',    label: 'text-rose-400'    },
  y: { bar: 'bg-emerald-500', label: 'text-emerald-400' },
  z: { bar: 'bg-sky-500',     label: 'text-sky-400'     },
} as const;

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-5">
      {children}
    </p>
  );
}

function VecRow({ axis, value, max }: { axis: keyof typeof AXIS_STYLE; value: number; max: number }) {
  const pct = Math.min(100, (Math.abs(value) / max) * 100);
  const { bar, label } = AXIS_STYLE[axis];
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between items-center mb-1.5">
        <span className={`font-mono font-bold text-xs uppercase ${label}`}>{axis}</span>
        <span className="text-slate-300 font-mono tabular-nums text-sm">{value.toFixed(2)}</span>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full ${bar} rounded-full transition-all duration-200`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const [data, setData]             = useState<SensorData>(INITIAL);
  const [fallDetected, setFall]     = useState(false);
  const [lastFall, setLastFall]     = useState<Date | null>(null);
  const [source, setSource]         = useState<'mock' | 'live'>('mock');
  const [lastLiveAt, setLastLiveAt] = useState<number | null>(null);
  const [streamUrl, setStreamUrl]   = useState('');
  const [streamInput, setInput]     = useState('');
  const [streamError, setStreamErr] = useState(false);
  const [hrAlert, setHrAlert]       = useState(false);
  const [demoActive, setDemoActive] = useState<'spike' | 'fall' | null>(null);

  // When > 0, the polling loop skips API updates so demo state isn't overwritten
  const demoPauseUntil  = useRef(0);
  const spikeIntervalId = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Browser voice alert ────────────────────────────────────────────────────
  // Fires whenever a fall is first detected. Works in any modern browser with
  // zero setup — no phone number, no API key, no verification required.
  useEffect(() => {
    if (!fallDetected) return;
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel(); // stop anything already speaking
    const msg = new SpeechSynthesisUtterance(
      'Warning! Fall detected. Please check on the patient immediately.'
    );
    msg.rate   = 0.88;  // slightly slower = more authoritative
    msg.pitch  = 1;
    msg.volume = 1;
    // Prefer a clear, natural-sounding voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      v.name.includes('Samantha') || v.name.includes('Google US') || v.lang === 'en-US'
    );
    if (preferred) msg.voice = preferred;
    window.speechSynthesis.speak(msg);
  }, [fallDetected]);

  // Speak when HR spike alert first fires
  useEffect(() => {
    if (!hrAlert) return;
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const msg = new SpeechSynthesisUtterance(
      `Warning! Elevated heart rate detected. Current reading is ${data.heartRate} beats per minute.`
    );
    msg.rate = 0.88; msg.pitch = 1; msg.volume = 1;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      v.name.includes('Samantha') || v.name.includes('Google US') || v.lang === 'en-US'
    );
    if (preferred) msg.voice = preferred;
    window.speechSynthesis.speak(msg);
  }, [hrAlert]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Polling ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/sensor');
        if (res.ok) {
          if (Date.now() < demoPauseUntil.current) return; // demo in progress
          const reading = await res.json();
          setSource('live');
          setLastLiveAt(Date.now());
          setData(prev => ({
            heartRate:     reading.heartRate     ?? prev.heartRate,
            accelerometer: reading.accelerometer ?? prev.accelerometer,
            gyroscope:     reading.gyroscope     ?? prev.gyroscope,
          }));
          if (reading.fallDetected) {
            setFall(true);
            setLastFall(new Date(reading.timestamp ?? Date.now()));
            setTimeout(() => setFall(false), 4000);
          }
          if (reading.hrAlert) {
            setHrAlert(true);
            setTimeout(() => setHrAlert(false), 10_000);
          }
          return;
        }
      } catch { /* fall through to mock */ }
      setSource('mock');
      setData(prev => nextData(prev));
      // No alarms in mock mode — demo buttons are the only way to trigger alerts.
    }, 500);
    return () => clearInterval(id);
  }, []);

  // ── Demo controls ──────────────────────────────────────────────────────────
  const handleSpikeHR = useCallback(() => {
    if (spikeIntervalId.current) clearInterval(spikeIntervalId.current);
    demoPauseUntil.current = Date.now() + 9000;
    setDemoActive('spike');
    let step = 0;
    let alertFired = false; // local flag — avoids stale-closure issues with state
    // Ramp up over 4 steps (~97→148 bpm), hold 4 steps, decay back to ~75
    spikeIntervalId.current = setInterval(() => {
      step++;
      const noise = Math.round((Math.random() - 0.5) * 5);
      const bpm =
        step <= 4  ? 80  + step * 17 + noise :   // ramp up
        step <= 8  ? 148 + noise              :   // hold peak
                     Math.max(75, 148 - (step - 8) * 12 + noise); // decay
      setData(prev => ({ ...prev, heartRate: bpm }));
      // Fire alert the FIRST time bpm crosses 120 — triggers banner + speech
      if (!alertFired && bpm >= 120) {
        alertFired = true;
        setHrAlert(true);
        setTimeout(() => setHrAlert(false), 10_000);
        // POST to API so the Twilio voice call fires too
        fetch('/api/sensor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ heartRate: bpm, hrAlert: true }),
        }).catch(() => {});
      }
      if (step >= 14) {
        clearInterval(spikeIntervalId.current!);
        spikeIntervalId.current = null;
        demoPauseUntil.current = 0;
        setDemoActive(null);
      }
    }, 600);
  }, []);

  const handleSimulateFall = useCallback(() => {
    demoPauseUntil.current = Date.now() + 5000;
    setDemoActive('fall');
    setFall(true);
    setLastFall(new Date());
    // Also POST to the server so the SMS fires and the log shows it
    fetch('/api/sensor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallDetected: true }),
    }).catch(() => {});
    setTimeout(() => {
      setFall(false);
      demoPauseUntil.current = 0;
      setDemoActive(null);
    }, 4000);
  }, []);

  const handleReset = useCallback(() => {
    if (spikeIntervalId.current) { clearInterval(spikeIntervalId.current); spikeIntervalId.current = null; }
    demoPauseUntil.current = 0;
    setDemoActive(null);
    setFall(false);
    setHrAlert(false);
    setData(prev => ({ ...prev, heartRate: 72 }));
  }, []);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const connectStream = useCallback(() => {
    const url = streamInput.trim();
    if (!url) return;
    setStreamErr(false);
    // Append /stream if the user just pasted an IP
    setStreamUrl(url.startsWith('http') ? url : `http://${url}:81/stream`);
  }, [streamInput]);

  // ── Derived state ──────────────────────────────────────────────────────────
  const hr = hrStatus(data.heartRate);
  const beatDuration = `${(60 / data.heartRate).toFixed(2)}s`;

  // Re-computed every render; safe because component re-renders every 500ms.
  const secsSinceLive = lastLiveAt ? Math.round((Date.now() - lastLiveAt) / 1000) : null;
  const connState =
    source === 'live'                                     ? 'connected' :
    lastLiveAt && secsSinceLive !== null && secsSinceLive < 8 ? 'lost'  :
                                                              'mock';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Full-page emergency tint */}
      {fallDetected && (
        <div
          className="fixed inset-0 bg-red-950/25 pointer-events-none z-10"
          style={{ animation: 'alert-flash 0.9s ease-in-out infinite' }}
        />
      )}

      <main className="relative min-h-screen bg-slate-950 text-white">

        {/* ── Header ── */}
        <header className="border-b border-slate-800/70 bg-slate-950/80 backdrop-blur sticky top-0 z-20 px-6 py-3">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-sm select-none">
                H
              </div>
              <div>
                <p className="text-sm font-bold leading-none tracking-tight">LexHealth</p>
                <p className="text-slate-500 text-xs mt-0.5 leading-none">Hackathon Monitor</p>
              </div>
            </div>

            {/* Connection badge */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold transition-colors duration-500 ${
              connState === 'connected' ? 'bg-emerald-950   border-emerald-800 text-emerald-300' :
              connState === 'lost'      ? 'bg-amber-950    border-amber-800  text-amber-300'   :
                                         'bg-slate-800/80  border-slate-700  text-slate-400'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                connState === 'connected' ? 'bg-emerald-400 animate-pulse' :
                connState === 'lost'      ? 'bg-amber-400'                 :
                                           'bg-slate-500'
              }`} />
              {connState === 'connected' && 'Device Connected'}
              {connState === 'lost'      && `Signal Lost · ${secsSinceLive}s ago`}
              {connState === 'mock'      && 'Mock Data'}
            </div>
          </div>
        </header>

        <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">

          {/* ── Fall alert banner ── */}
          {fallDetected && (
            <div
              className="flex items-center gap-5 bg-red-600 rounded-2xl px-6 py-4 shadow-2xl shadow-red-950/80"
              style={{ animation: 'alert-flash 1s ease-in-out infinite' }}
            >
              <span className="text-4xl leading-none select-none">⚠</span>
              <div className="flex-1 min-w-0">
                <p className="font-extrabold text-xl leading-none tracking-tight">Fall Detected</p>
                <p className="text-red-200 text-sm mt-1">
                  {lastFall?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </p>
              </div>
              <div className="flex items-center gap-2.5 flex-shrink-0">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-300 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-red-200" />
                </span>
                <span className="text-sm text-red-100 font-medium hidden sm:block">
                  Alerting Emergency Contact
                </span>
              </div>
            </div>
          )}

          {/* ── HR spike alert banner ── */}
          {hrAlert && !fallDetected && (
            <div className="flex items-center gap-5 bg-amber-500 rounded-2xl px-6 py-4 shadow-2xl shadow-amber-950/60">
              <span className="text-4xl leading-none select-none">⚡</span>
              <div className="flex-1 min-w-0">
                <p className="font-extrabold text-xl leading-none tracking-tight text-amber-950">
                  Elevated Heart Rate
                </p>
                <p className="text-amber-900 text-sm mt-1 font-medium">
                  {data.heartRate} BPM — sustained above 120 bpm
                </p>
              </div>
              <div className="flex items-center gap-2.5 flex-shrink-0">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-900 opacity-60" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-900" />
                </span>
                <span className="text-sm text-amber-900 font-semibold hidden sm:block">
                  Alerting Emergency Contact
                </span>
              </div>
            </div>
          )}

          {/* ── Demo controls ── */}
          <div className="border border-slate-700 border-dashed rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-shrink-0">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Demo Controls</p>
              <p className="text-slate-600 text-xs mt-0.5">For presentations — simulates sensor events</p>
            </div>
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <button
                onClick={handleSpikeHR}
                disabled={demoActive !== null}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-rose-950 hover:bg-rose-900 border border-rose-800 text-rose-300 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {demoActive === 'spike' ? (
                  <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
                ) : '↑'}
                Heart Rate Spike
              </button>
              <button
                onClick={handleSimulateFall}
                disabled={demoActive !== null}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-amber-950 hover:bg-amber-900 border border-amber-800 text-amber-300 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {demoActive === 'fall' ? (
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                ) : '⚠'}
                Simulate Fall
              </button>
              <button
                onClick={handleReset}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 transition-all active:scale-95"
              >
                ↺ Reset
              </button>
            </div>
          </div>

          {/* ── Sensor grid ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

            {/* Heart Rate */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col">
              <SectionLabel>Heart Rate</SectionLabel>
              <div className="flex-1 flex items-center gap-6">
                {/* Animated pulse ring */}
                <div className="relative w-20 h-20 flex-shrink-0 flex items-center justify-center">
                  <div
                    className="absolute inset-0 rounded-full border-2"
                    style={{
                      borderColor: hr.ring,
                      animation: `heartring ${beatDuration} ease-out infinite`,
                    }}
                  />
                  <div
                    className="absolute inset-3 rounded-full border opacity-20"
                    style={{ borderColor: hr.ring }}
                  />
                  <span className="text-lg font-bold font-mono tabular-nums" style={{ color: hr.ring }}>
                    {data.heartRate}
                  </span>
                </div>
                <div>
                  <div className="flex items-end gap-1.5">
                    <span className="text-5xl font-bold font-mono tabular-nums leading-none text-white">
                      {data.heartRate}
                    </span>
                    <span className="text-slate-500 text-sm pb-1">BPM</span>
                  </div>
                  <span className={`inline-flex items-center gap-1.5 mt-3 text-sm font-semibold ${hr.color}`}>
                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    {hr.label}
                  </span>
                </div>
              </div>
            </div>

            {/* Fall Detection */}
            <div className={`rounded-2xl border p-6 transition-all duration-500 ${
              fallDetected
                ? 'bg-red-900/70 border-red-600 shadow-xl shadow-red-950/60'
                : 'bg-slate-900  border-slate-800'
            }`}>
              <SectionLabel>Fall Detection</SectionLabel>
              {fallDetected ? (
                <div>
                  <p className="text-4xl font-extrabold text-red-200 leading-tight tracking-tight">
                    ⚠ FALL<br />DETECTED
                  </p>
                  <p className="text-red-400 text-sm mt-3">
                    {lastFall?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </p>
                </div>
              ) : (
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-full bg-emerald-900/50 border border-emerald-800 flex items-center justify-center flex-shrink-0">
                    <span className="text-emerald-400 text-xl font-bold leading-none">✓</span>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-emerald-400">Safe</p>
                    <p className="text-slate-500 text-sm mt-1">
                      {lastFall
                        ? `Last event: ${lastFall.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                        : 'No events recorded'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Sensor Status */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <SectionLabel>Sensors</SectionLabel>
              <div className="space-y-3">
                {([
                  { name: 'Heart Rate',    online: true         },
                  { name: 'Accelerometer', online: true         },
                  { name: 'Gyroscope',     online: true         },
                  { name: 'Camera',        online: !!streamUrl && !streamError },
                ] as const).map(({ name, online }) => (
                  <div key={name} className="flex justify-between items-center">
                    <span className="text-slate-400 text-sm">{name}</span>
                    <span className={`flex items-center gap-1.5 text-xs font-semibold ${online ? 'text-emerald-400' : 'text-slate-600'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                      {online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-slate-800 flex justify-between items-center text-xs">
                <span className="text-slate-500">Data source</span>
                <span className={source === 'live' ? 'text-emerald-400 font-medium' : 'text-slate-500'}>
                  {source === 'live' ? 'API · Live' : 'Simulated'}
                </span>
              </div>
            </div>

            {/* Accelerometer */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <SectionLabel>
                Accelerometer{' '}
                <span className="normal-case font-normal text-slate-600 tracking-normal">m/s²</span>
              </SectionLabel>
              <VecRow axis="x" value={data.accelerometer.x} max={5}  />
              <VecRow axis="y" value={data.accelerometer.y} max={5}  />
              <VecRow axis="z" value={data.accelerometer.z} max={15} />
            </div>

            {/* Gyroscope */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <SectionLabel>
                Gyroscope{' '}
                <span className="normal-case font-normal text-slate-600 tracking-normal">rad/s</span>
              </SectionLabel>
              <VecRow axis="x" value={data.gyroscope.x} max={2} />
              <VecRow axis="y" value={data.gyroscope.y} max={2} />
              <VecRow axis="z" value={data.gyroscope.z} max={2} />
            </div>

            {/* Camera Preview — ESP32-CAM MJPEG stream */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col">
              <SectionLabel>Camera Preview</SectionLabel>

              {/* Stream viewport */}
              <div className="flex-1 aspect-video bg-slate-800 rounded-xl overflow-hidden mb-4 flex items-center justify-center relative">
                {streamUrl ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={streamUrl}
                      alt="ESP32-CAM stream"
                      className="w-full h-full object-cover"
                      onError={() => setStreamErr(true)}
                      onLoad={() => setStreamErr(false)}
                    />
                    {streamError && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-800 gap-2">
                        <p className="text-rose-400 text-xs text-center px-4">
                          Cannot reach stream. Check ESP32 IP and port 81.
                        </p>
                        <button
                          onClick={() => setStreamUrl('')}
                          className="text-xs text-slate-500 underline"
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-slate-600 text-sm">No stream connected</p>
                )}
              </div>

              {/* ESP32 IP input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={streamInput}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && connectStream()}
                  placeholder="192.168.x.x"
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  onClick={streamUrl ? () => { setStreamUrl(''); setStreamErr(false); } : connectStream}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all active:scale-95 flex-shrink-0 ${
                    streamUrl
                      ? 'bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-800'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-950/60'
                  }`}
                >
                  {streamUrl ? 'Disconnect' : 'Connect'}
                </button>
              </div>
              <p className="text-slate-600 text-xs mt-2">
                Enter your ESP32-CAM&apos;s IP — stream runs on port 81
              </p>
            </div>

          </div>
        </div>
      </main>
    </>
  );
}
