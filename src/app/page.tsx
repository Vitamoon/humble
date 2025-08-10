"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, StopCircle, Video, Volume2, VolumeX, Sparkles, Lock } from "lucide-react";

// Minimal Vapi types we actually use
interface VapiLike {
  start?: (opts?: unknown) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  on?: (ev: string, cb: (payload: unknown) => void) => void;
}

type VapiClient = unknown;

declare global {
  interface Window {
    Vapi?: VapiClient;
    // MediaPipe globals (runtime provided by CDN). We keep them unknown and narrow locally.
    faceDetection?: unknown;
    faceLandmarksDetection?: unknown;
    FaceMesh?: unknown;
    faceLandmarksDetectionLoaded?: boolean;
    faceDetectionLoaded?: boolean;
    // cache a single FaceMesh instance for stability
    _faceMeshInstance?: unknown;
  }
}

export default function Home() {
  const [recording, setRecording] = useState(false);
  const [listeningError, setListeningError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [partial, setPartial] = useState("");
  const [responses, setResponses] = useState<string[]>([]);
  const [ttsOn, setTtsOn] = useState(true);
  const [harshness, setHarshness] = useState(7);
  const [nicenessPaid, setNicenessPaid] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [focusScore, setFocusScore] = useState<number | null>(null);
  const vapiRef = useRef<unknown>(null);
  const [signals, setSignals] = useState<{
    presence: number;
    pitch: number;
    roll: number;
    attention: number;
    distraction: boolean;
    phoneLikely: number;
    screenLikely: number;
  } | null>(null);
  // smoothing buffers
  const smoothedRef = useRef<{ presence: number; attention: number; pitch: number; roll: number; phoneLikely: number; screenLikely: number; distraction: number }>({ presence: 0, attention: 0, pitch: 0, roll: 0, phoneLikely: 0, screenLikely: 0, distraction: 0 });
  const SMOOTH_ALPHA = 0.2; // EMA factor for smoothing
  // VU meter state
  const [vu, setVu] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scopeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastVapiMetaSentRef = useRef<number>(0);

  const vapiEnabled = process.env.NEXT_PUBLIC_VAPI_ENABLED === "true";

  // Debounce management for STT finalization
  const idleTimerRef = useRef<number | null>(null);
  const partialBufferRef = useRef<string>("");
  const lastPartialAtRef = useRef<number>(0);
  const DEBOUNCE_MS = 3000; // as requested

  const clearIdleTimer = () => {
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };
  const scheduleIdleFinalize = () => {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      // finalize if we have buffered text
      const buf = partialBufferRef.current.trim();
      if (buf) finalizeTranscript(buf);
    }, DEBOUNCE_MS);
  };
  const onPartialText = (text: string) => {
    partialBufferRef.current = text;
    setPartial(text);
    lastPartialAtRef.current = Date.now();
    scheduleIdleFinalize();
  };
  const finalizeTranscript = (text: string) => {
    clearIdleTimer();
    partialBufferRef.current = "";
    setPartial("");
    setTranscript(text);
    const reply = harshCoachResponse(text, harshness, nicenessPaid);
    setResponses((r) => [...r, reply]);
    if (ttsOn && !vapiRef.current) speak(reply);
  };

  // Load Vapi Web SDK when enabled
  useEffect(() => {
    if (!vapiEnabled || vapiRef.current) return;
    const script = document.createElement("script");
    script.src = "https://unpkg.com/@vapi-ai/web";
    script.async = true;
    script.onload = () => {
      try {
        const VapiCtor = (window as unknown as { Vapi?: new (cfg: { apiKey?: string }) => unknown }).Vapi;
        const apiKey = process.env.NEXT_PUBLIC_VAPI_API_KEY as string | undefined;
        vapiRef.current = VapiCtor ? new VapiCtor({ apiKey }) : null;
      } catch (e) {
        vapiRef.current = null;
      }
    };
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, [vapiEnabled]);

  // Load MediaPipe FaceDetection and FaceMesh via script tags
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.faceDetectionLoaded && window.faceLandmarksDetectionLoaded) return;

    if (!window.faceDetectionLoaded) {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/face_detection.js";
      script.async = true;
      script.onload = () => {
        window.faceDetectionLoaded = true;
      };
      document.body.appendChild(script);
    }

    if (!window.faceLandmarksDetectionLoaded) {
      const script2 = document.createElement("script");
      script2.src = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js";
      script2.async = true;
      script2.onload = () => {
        window.faceLandmarksDetectionLoaded = true;
      };
      document.body.appendChild(script2);
    }
  }, []);

  // Initialize webcam and start vision loop
  useEffect(() => {
    let stream: MediaStream | null = null;
    const init = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        startVisionLoop();
      } catch (e) {
        console.warn("Webcam unavailable", e);
      }
    };
    init();
    return () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line
  }, []);

  // vision loop with throttled MediaPipe (~15 fps)
  const lastProcessAtRef = useRef<number>(0);
  const startVisionLoop = () => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    const loop = async () => {
      if (ctx && video.readyState >= 2) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Heuristic signals; to be replaced with MediaPipe when loaded
        let s = heuristicSignals(ctx, canvas.width, canvas.height);

        const now = performance.now();
        const shouldProcess = now - lastProcessAtRef.current > 66; // ~15fps
        if (
          shouldProcess &&
          typeof window !== "undefined" &&
          window.faceDetectionLoaded &&
          window.faceLandmarksDetectionLoaded &&
          typeof window.FaceMesh !== "undefined"
        ) {
          try {
            lastProcessAtRef.current = now;
            // ensure single instance
            const FaceMeshCtor = (window.FaceMesh as unknown) as new (opts: { locateFile: (file: string) => string }) => {
              setOptions: (o: unknown) => void;
              onResults: (cb: (res: unknown) => void) => void;
              send: (args: { image: HTMLVideoElement }) => Promise<void>;
            };
            if (!window._faceMeshInstance && typeof FaceMeshCtor === "function") {
              window._faceMeshInstance = new FaceMeshCtor({ locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
              const inst = window._faceMeshInstance as unknown as { setOptions: (o: unknown) => void; onResults: (cb: (res: unknown) => void) => void };
              inst.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5 });
            }
            const faceMesh = window._faceMeshInstance as unknown as {
              onResults: (cb: (res: { multiFaceLandmarks?: Array<Array<{ x: number; y: number; z: number }>> }) => void) => void;
              send: (args: { image: HTMLVideoElement }) => Promise<void>;
            };
            const results = await new Promise<{ multiFaceLandmarks?: Array<Array<{ x: number; y: number; z: number }>> }>((resolve) => {
              faceMesh.onResults((res) => resolve(res));
              void faceMesh.send({ image: video });
            });
            if (results && results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
              const landmarks = results.multiFaceLandmarks[0];
              const leftEye = landmarks[33];
              const rightEye = landmarks[263];
              const nose = landmarks[1];
              const dx = rightEye.x - leftEye.x;
              const dy = rightEye.y - leftEye.y;
              const roll = Math.atan2(dy, dx) * (180 / Math.PI);
              const pitch = (nose.y - (leftEye.y + rightEye.y) / 2) * 100 || 0;
              const attention = Math.max(0, 100 - Math.abs(nose.z * 100));
              const distraction = Math.abs(nose.x - 0.5) > 0.2;
              s = {
                presence: 100,
                pitch,
                roll,
                attention,
                distraction,
                phoneLikely: s.phoneLikely,
                screenLikely: s.screenLikely,
              };
            }
          } catch {
            // ignore MediaPipe failure; keep heuristic s
          }
        }

        // apply smoothing/hysteresis
        const sm = smoothedRef.current;
        sm.presence = smooth(sm.presence, clamp01(s.presence));
        sm.attention = smooth(sm.attention, clamp01(s.attention));
        sm.pitch = smooth(sm.pitch, s.pitch);
        sm.roll = smooth(sm.roll, s.roll);
        sm.phoneLikely = smooth(sm.phoneLikely, clamp01(s.phoneLikely));
        sm.screenLikely = smooth(sm.screenLikely, clamp01(s.screenLikely));
        sm.distraction = smooth(sm.distraction, s.distraction ? 100 : 0);
        const smoothedSignals = {
          presence: sm.presence,
          attention: sm.attention,
          pitch: sm.pitch,
          roll: sm.roll,
          phoneLikely: sm.phoneLikely,
          screenLikely: sm.screenLikely,
          distraction: sm.distraction > 50,
        };

        setSignals(smoothedSignals);
        const score = computeFocusScore(smoothedSignals);
        setFocusScore(Math.round(score));
        pushVapiVision(smoothedSignals);

      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };

  const computeFocusScore = (s: { presence: number; attention: number; distraction: boolean }) => {
    let score = 0.6 * s.presence + 0.6 * s.attention;
    if (s.distraction) score -= 30;
    return Math.max(0, Math.min(100, score));
  };

  const heuristicSignals = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const data = ctx.getImageData(0, 0, w, h).data;
    let center = 0, edges = 0, nC = 0, nE = 0;
    for (let y = 0; y < h; y += 16) {
      for (let x = 0; x < w; x += 16) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const isEdge = x < w * 0.1 || y < h * 0.1 || x > w * 0.9 || y > h * 0.9;
        if (isEdge) { edges += l; nE++; } else { center += l; nC++; }
      }
    }
    const presence = Math.min(100, Math.max(0, (center / Math.max(1, nC) - edges / Math.max(1, nE))));
    const pitch = Math.max(-20, Math.min(20, (center - edges) / 50));
    const roll = Math.max(-20, Math.min(20, (edges - center) / 50));
    const attention = Math.min(100, Math.max(0, (center / Math.max(1, nC)) / 2));
    const phoneLikely = Math.max(0, Math.min(100, (edges / Math.max(1, nE)) - (center / Math.max(1, nC))));
    const screenLikely = Math.max(0, Math.min(100, (center / Math.max(1, nC)) - (edges / Math.max(1, nE))));
    const distraction = attention < 20 || presence < 5;
    return { presence, pitch, roll, attention, distraction, phoneLikely, screenLikely };
  };

  const smooth = (prev: number, next: number, alpha = SMOOTH_ALPHA) => prev + (next - prev) * alpha;
  const clamp01 = (v: number) => Math.max(0, Math.min(100, v));

  // Oscilloscope waveform rendering
  const scopeRAF = useRef<number | null>(null);
  const startOscilloscope = () => {
    const canvas = scopeCanvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const draw = () => {
      if (!analyserRef.current || !scopeCanvasRef.current) return;
      const c = scopeCanvasRef.current;
      const context = c.getContext("2d");
      if (!context) return;
      c.width = c.clientWidth;
      c.height = 60;
      analyserRef.current.getByteTimeDomainData(dataArray);
      context.clearRect(0, 0, c.width, c.height);
      context.lineWidth = 2;
      context.strokeStyle = "#10b981"; // emerald
      context.beginPath();
      const sliceWidth = c.width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * c.height) / 2;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
        x += sliceWidth;
      }
      context.stroke();
      scopeRAF.current = requestAnimationFrame(draw);
    };
    if (scopeRAF.current) cancelAnimationFrame(scopeRAF.current);
    scopeRAF.current = requestAnimationFrame(draw);
  };
  const stopOscilloscope = () => {
    if (scopeRAF.current) cancelAnimationFrame(scopeRAF.current);
    scopeRAF.current = null;
    const c = scopeCanvasRef.current;
    if (c) {
      const ctx = c.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    }
  };

  // Start Vapi or fallback to immediate local live recognition
  const startVapi = async () => {
    setListeningError(null);
    setPartial("");
    partialBufferRef.current = "";
    clearIdleTimer();
    // Prefer Vapi if present
    if (vapiRef.current) {
      try {
        const v = vapiRef.current as VapiLike & { update?: (opts: { metadata?: unknown }) => void };
        // Register listeners BEFORE starting, so early partials are not missed
        v.on?.("transcript.partial", (t: unknown) => onPartialText(String(t ?? "")));
        v.on?.("transcript.final", (t: unknown) => {
          const text = String(t ?? "");
          if (text.trim()) finalizeTranscript(text);
        });
        await v.start?.({ metadata: { harshness, nicenessPaid } });
        setRecording(true);
        return;
      } catch (e) {
        setListeningError("Failed to start Vapi session. Falling back to local mic.");
      }
    }
    // Immediate local fallback with Web Speech
    try {
      await startLocalLiveRecognition();
      setRecording(true);
    } catch (e) {
      setListeningError("Mic permission denied or Web Speech unavailable.");
    }
  };

  // Stop Vapi or local recognition, and stop oscilloscope
  const stopVapi = async () => {
    clearIdleTimer();
    stopOscilloscope();
    if (vapiRef.current) {
      try {
        const v = vapiRef.current as VapiLike;
        await v.stop?.();
      } catch {}
    }
    stopLocalLiveRecognition();
    setRecording(false);
  };

  // Fallback local mic + browser TTS (now routes to live recognition)
  const startRecordingLocal = async () => {
    // kept for backward compat, now routes to live recognition
    await startLocalLiveRecognition();
  };

  const stopRecordingLocal = () => {
    stopLocalLiveRecognition();
  };

  // Live Web Speech + analyser path
  const recognitionRef = useRef<unknown>(null);
  const startLocalLiveRecognition = async () => {
    setListeningError(null);
    setPartial("");
    partialBufferRef.current = "";
    clearIdleTimer();
    // Mic stream for VU and scope
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioStreamRef.current = stream;
    try {
      const ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      const source = ac.createMediaStreamSource(stream);
      source.connect(analyser);
      startOscilloscope();
      // kick VU loop if not already running (will share analyser)
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setVu(Math.min(1, Math.max(0, rms * 4)));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {}

    type SRConstructor = new () => {
      lang: string;
      interimResults: boolean;
      maxAlternatives: number;
      onresult: ((e: unknown) => void) | null;
      onerror: ((e: unknown) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    const w = window as unknown as { SpeechRecognition?: SRConstructor; webkitSpeechRecognition?: SRConstructor };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) throw new Error("SpeechRecognition not available");
    const rec = new SR();
    recognitionRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e: unknown) => {
      const anyEvt = e as { results?: Array<Array<{ transcript?: string; isFinal?: boolean }>> };
      const last = anyEvt.results?.[anyEvt.results.length - 1]?.[0];
      const cur = last?.transcript || "";
      onPartialText(cur);
    };
    rec.onerror = () => {
      setListeningError("Speech recognition failed.");
    };
    rec.onend = () => {
      const buf = partialBufferRef.current.trim();
      if (buf) finalizeTranscript(buf);
      // keep mic alive but stop analyser
      stopOscilloscope();
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((t) => t.stop());
        audioStreamRef.current = null;
      }
      analyserRef.current = null;
    };
    rec.start();
  };

  const stopLocalLiveRecognition = () => {
    const rec = recognitionRef.current as { stop?: () => void } | null;
    try { rec?.stop?.(); } catch {}
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
    }
    analyserRef.current = null;
    stopOscilloscope();
  };

  const recognizeLive = async (): Promise<void> => {
    // Not used anymore, but kept for API compatibility
    return;
  };

  const speak = (text: string) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.0;
      utter.pitch = 1.0;
      synth.cancel();
      synth.speak(utter);
    } catch {}
  };

  const harshCoachResponse = (input: string, harsh: number, nicePaid: boolean) => {
    const trimmed = input.trim();
    if (!trimmed) return "I can't critique silence. State your goal, your deadline, and what you shipped since last check-in.";
    const harshLines = [
      "Your goal is vague. Specify the user outcome and the metric you'll move this week.",
      "Deadlines without deliverables are fantasies. Name the artifact and date.",
      "You're optimizing comfort over impact. Hit the riskiest assumption in 48 hours.",
      "Cut scope now. Remove half the features; double the quality.",
      "Who did you speak to? How many users? What actually changed?",
      "Stop polishing. Ship something testable today.",
      "No more planning theater. Pick one decision and commit by tonight.",
      "Metrics over vibes. What is success by Friday in a single number?",
      "Your excuse is a choice. What is the smallest thing you can ship in 3 hours?",
      "If it's not on the calendar, it's not happening. Schedule it now.",
    ];
    const niceLines = [
      "Good direction. Let's make it concrete: what single outcome by Friday?",
      "Scope it to one artifact. What's the smallest version to validate?",
      "Talk to two users today and extract one actionable change.",
      "Cut one feature to improve quality elsewhere.",
    ];
    const pool = (nicePaid ? niceLines : harshLines).slice(0, Math.max(3, Math.min(10, harsh)));
    const idx = Math.floor((trimmed.length + harsh) % pool.length);
    return `You said: "${trimmed}". ${pool[idx]}`;
  };

  const pushVapiVision = (sig: { presence: number; attention: number; distraction: boolean } | null) => {
    if (!sig || !vapiRef.current) return;
    const now = performance.now();
    if (now - lastVapiMetaSentRef.current < 500) return; // ~2Hz
    lastVapiMetaSentRef.current = now;
    try {
      const v = vapiRef.current as VapiLike & { update?: (opts: { metadata?: unknown }) => void };
      v.update?.({ metadata: { focus: Math.round(computeFocusScore(sig)), presence: sig.presence, attention: sig.attention, distracted: sig.distraction } });
    } catch {}
  };

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded bg-neutral-800 grid place-items-center text-neutral-300 font-bold">H</div>
            <h1 className="text-xl font-semibold tracking-tight">Humble</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setTtsOn((v) => !v)}
              className="inline-flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm hover:bg-neutral-800"
              aria-label={ttsOn ? "Disable voice" : "Enable voice"}
            >
              {ttsOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
              {ttsOn ? "Voice on" : "Voice off"}
            </button>
            <div className="flex items-center gap-2">
              <label className="text-xs text-neutral-400">Harshness</label>
              <input
                type="range"
                min={0}
                max={10}
                value={harshness}
                onChange={(e) => setHarshness(Number(e.target.value))}
                className="accent-emerald-500"
              />
              <span className="text-xs text-neutral-400 w-6 text-right">{harshness}</span>
            </div>
            <button
              onClick={() => (nicenessPaid ? setNicenessPaid(false) : setShowPaywall(true))}
              className="inline-flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm hover:bg-neutral-800"
            >
              <Sparkles size={16} /> Niceness {nicenessPaid ? "on" : "off"}
              {!nicenessPaid && <Lock size={14} className="opacity-60" />}
            </button>
          </div>
        </header>

        <section className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-[1fr_360px]">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <h2 className="mb-2 text-sm font-medium text-neutral-400">Conversation</h2>
            {partial && <div className="mb-2 text-xs text-neutral-500">{partial}</div>}
            <div className="mb-3 h-1.5 w-full rounded bg-neutral-800 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-[width] duration-75" style={{ width: `${Math.round(vu * 100)}%` }} />
            </div>
            <canvas ref={scopeCanvasRef} className="mb-3 block w-full" style={{ height: 60 }} />
            <div className="space-y-3">
              {responses.length === 0 && (
                <p className="text-neutral-400">Press record and tell Humble what you shipped and what's next. Expect blunt feedback.</p>
              )}
              {responses.map((r, i) => (
                <div key={i} className="rounded-md border border-neutral-800 bg-neutral-900 p-3 text-neutral-200">
                  {r}
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-3">
              {!recording ? (
                <button
                  onClick={startVapi}
                  className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
                >
                  <Mic size={16} /> Start talking
                </button>
              ) : (
                <button
                  onClick={stopVapi}
                  className="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-500"
                >
                  <StopCircle size={16} /> Stop
                </button>
              )}
              {listeningError && <span className="text-xs text-red-400">{listeningError}</span>}
            </div>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-neutral-400">
              <Video size={16} /> Webcam context
            </h2>
            <div className="relative">
              <video ref={videoRef} autoPlay playsInline muted className="aspect-video w-full rounded-md border border-neutral-800 bg-black object-cover" />
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none opacity-0" />
            </div>
            <div className="mt-2 text-xs text-neutral-400">
              <div>Focus score: {focusScore ?? "-"}</div>
              {signals && (
                <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
                  <div>Presence: {signals.presence.toFixed(0)}</div>
                  <div>Attention: {signals.attention.toFixed(0)}</div>
                  <div>Pitch: {signals.pitch.toFixed(0)}°</div>
                  <div>Roll: {signals.roll.toFixed(0)}°</div>
                  <div>Phone likely: {signals.phoneLikely.toFixed(0)}</div>
                  <div>Screen likely: {signals.screenLikely.toFixed(0)}</div>
                  <div>Distracted: {signals.distraction ? "yes" : "no"}</div>
                </div>
              )}
              <p className="mt-1 text-neutral-500">Heuristic signals shown; MediaPipe models will refine these.</p>
            </div>
          </div>
        </section>

        {transcript && (<div className="mt-6 text-xs text-neutral-400">Last heard: "{transcript}"</div>)}

        {showPaywall && (
          <div className="fixed inset-0 bg-black/70 grid place-items-center z-50">
            <div className="w-[520px] max-w-[90vw] rounded-lg border border-neutral-800 bg-neutral-925 p-6 shadow-xl">
              <h3 className="text-lg font-semibold">Unlock Niceness</h3>
              <p className="mt-2 text-sm text-neutral-400">Humble defaults to tough love. To enable a kinder coaching style, upgrade your plan.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setShowPaywall(false)} className="rounded-md border border-neutral-800 px-3 py-2 text-sm hover:bg-neutral-800">Cancel</button>
                <button onClick={() => { setNicenessPaid(true); setShowPaywall(false); }} className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium hover:bg-emerald-500">Simulate Upgrade</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
