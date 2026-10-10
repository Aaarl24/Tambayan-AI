// App.tsx — Tambay-AI Cafe Console: the phone that sits in the cafe,
// runs on-device inference, and feeds the student map with anonymized
// counts only (never images).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useKeepAwake } from 'expo-keep-awake';
import {
  Camera,
  runAsync,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { NitroModules } from 'react-native-nitro-modules';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import { Worklets, useSharedValue } from 'react-native-worklets-core';
import { Canvas, Rect } from '@shopify/react-native-skia';

import {
  COLORS,
  INFERENCE_INTERVAL_MS,
  MODEL_INPUT_SIZE,
  computeCounts,
  mapToScreen,
  parseDetections,
  type Counts,
  type Detection,
  type ScreenBox,
} from './detection';
import { API_URL, BRANCH_NAME, SYNC_INTERVAL_MS } from './config';
import { syncTelemetryToCloud, type SyncResult } from './cloud';
import {
  AVAILABILITY_COLOR,
  AVAILABILITY_LABEL,
  OUTLET_LABEL,
  deriveTelemetry,
} from './telemetry';

type Rotation = '0deg' | '90deg' | '180deg' | '270deg';
const ROTATIONS: Rotation[] = ['0deg', '90deg', '180deg', '270deg'];
const STORAGE_KEY = '@tambay/console';

interface FrameSize {
  width: number;
  height: number;
}
interface ConsolePrefs {
  branch: string;
  rotation: Rotation;
  mirror: boolean;
}
interface CafeOption {
  branch: string;
  name: string;
  demo?: boolean;
}

const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Median of a small window, element-wise — stops the numbers flickering. */
function median3(window3: Counts[]): Counts {
  const med = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    vacant: med(window3.map((c) => c.vacant)),
    occupied: med(window3.map((c) => c.occupied)),
    laptops: med(window3.map((c) => c.laptops)),
  };
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-full px-3.5 py-1.5 ${active ? 'bg-emerald-500' : 'bg-slate-800'}`}
    >
      <Text className={`text-xs font-semibold ${active ? 'text-slate-950' : 'text-slate-300'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function CafeConsole(): React.JSX.Element {
  useKeepAwake('tambay-console'); // a console phone must not sleep on the job
  const { width: screenW, height: screenH } = useWindowDimensions();

  // 1. Hardware & model initialization ---------------------------------------
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  const plugin = useTensorflowModel(require('../assets/ssd_mobilenet_v1.tflite'), []);
  const model = plugin.state === 'loaded' ? plugin.model : undefined;
  const { resize } = useResizePlugin();
  const boxedModel = useMemo(() => (model != null ? NitroModules.box(model) : undefined), [model]);

  useEffect(() => {
    if (model != null) {
      try {
        console.log('[Tambay-AI] model inputs:', JSON.stringify(model.inputs));
        console.log('[Tambay-AI] model outputs:', JSON.stringify(model.outputs));
      } catch (e) {
        console.log('[Tambay-AI] could not read model tensor info', e);
      }
    }
  }, [model]);

  // 2. Console state: calibration, branch, controls ---------------------------
  const [branch, setBranch] = useState(BRANCH_NAME);
  const [mirror, setMirror] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [sharingPaused, setSharingPaused] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualBranch, setManualBranch] = useState('');
  const [cafes, setCafes] = useState<CafeOption[]>([]);

  // Rotation is read inside the frame-processor worklet, so it lives in a
  // worklets-core shared value (Reanimated shared values cannot cross).
  const frameRotation = useSharedValue<Rotation>('90deg');
  const [rotation, setRotationState] = useState<Rotation>('90deg');
  const setRotation = useCallback(
    (r: Rotation) => {
      setRotationState(r);
      frameRotation.value = r;
    },
    [frameRotation]
  );

  // Load persisted prefs once.
  useEffect(() => {
    void AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const p = JSON.parse(raw) as Partial<ConsolePrefs>;
        if (typeof p.branch === 'string' && p.branch) setBranch(p.branch);
        if (p.rotation && ROTATIONS.includes(p.rotation)) setRotation(p.rotation);
        if (typeof p.mirror === 'boolean') setMirror(p.mirror);
      } catch {
        /* corrupt prefs — fall back to defaults */
      }
    });
  }, [setRotation]);
  // Persist on change.
  useEffect(() => {
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ branch, rotation, mirror }));
  }, [branch, rotation, mirror]);

  // Cafe picker options from the server (manual fallback if unreachable).
  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/api/cafes`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d.cafes)) {
          setCafes(d.cafes.map((c: { branch: string; name: string; demo?: boolean }) => ({ branch: c.branch, name: c.name, demo: c.demo })));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 3. Frame processor -> JS thread bridge ------------------------------------
  const [detections, setDetections] = useState<Detection[]>([]);
  const [frameSize, setFrameSize] = useState<FrameSize>({ width: 3, height: 4 });
  const [cameraLayout, setCameraLayout] = useState<FrameSize>({ width: 0, height: 0 });

  const lastInferenceMs = useSharedValue<number>(0);

  const handleResults = useCallback((next: Detection[], fw: number, fh: number) => {
    setDetections(next);
    setFrameSize((prev) => (prev.width === fw && prev.height === fh ? prev : { width: fw, height: fh }));
  }, []);
  const handleResultsOnJS = useMemo(() => Worklets.createRunOnJS(handleResults), [handleResults]);

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      if (boxedModel == null) return;

      runAsync(frame, () => {
        'worklet';
        const now = Date.now();
        if (now - lastInferenceMs.value < INFERENCE_INTERVAL_MS) return;
        lastInferenceMs.value = now;

        // Calibrated rotation (see the Calibrate control): '90deg' is the
        // default guess — landscape sensor buffer -> portrait model space.
        const rot = frameRotation.value;
        const input = resize(frame, {
          scale: { width: MODEL_INPUT_SIZE, height: MODEL_INPUT_SIZE },
          pixelFormat: 'rgb',
          dataType: 'uint8',
          rotation: rot,
        });

        const model = boxedModel.unbox();
        const outputs = model.runSync([input.buffer as ArrayBuffer]);
        const boxes = new Float32Array(outputs[0]);
        const classes = new Float32Array(outputs[1]);
        const scores = new Float32Array(outputs[2]);
        const count = Math.round(new Float32Array(outputs[3])[0]);

        const found = parseDetections(boxes, classes, scores, count);

        // Frame dims *as the model sees them*, after rotation.
        const portrait = rot === '90deg' || rot === '270deg';
        const fw = portrait ? Math.min(frame.width, frame.height) : Math.max(frame.width, frame.height);
        const fh = portrait ? Math.max(frame.width, frame.height) : Math.min(frame.width, frame.height);
        handleResultsOnJS(found, fw, fh);
      });
    },
    [boxedModel, resize, lastInferenceMs, handleResultsOnJS, frameRotation]
  );

  // 4. Derived counts, edge telemetry, Skia boxes ------------------------------
  // Mirror flips boxes in model space so chair/person overlap stays correct.
  const oriented = useMemo(
    () => (mirror ? detections.map((d) => ({ ...d, x: 1 - d.x - d.w })) : detections),
    [detections, mirror]
  );
  const { counts: rawCounts, vacantChairs } = useMemo(() => computeCounts(oriented), [oriented]);

  // Median-of-3 smoothing on displayed and synced counts.
  const window3 = useRef<Counts[]>([]);
  const counts = useMemo(() => {
    const w = [...window3.current, rawCounts].slice(-3);
    window3.current = w;
    return w.length === 3 ? median3(w) : rawCounts;
  }, [rawCounts]);
  const telemetry = useMemo(() => deriveTelemetry(counts), [counts]);

  const boxes = useMemo<ScreenBox[]>(() => {
    if (cameraLayout.width === 0 || cameraLayout.height === 0) return [];
    const project = (d: Detection) =>
      mapToScreen(d, frameSize.width, frameSize.height, cameraLayout.width, cameraLayout.height);
    const out: ScreenBox[] = [];
    for (const d of vacantChairs) out.push({ label: 'vacantChair', color: COLORS.chair, ...project(d) });
    for (const d of oriented) {
      if (d.label === 'person') out.push({ label: 'person', color: COLORS.person, ...project(d) });
      else if (d.label === 'laptop') out.push({ label: 'laptop', color: COLORS.laptop, ...project(d) });
    }
    return out;
  }, [oriented, vacantChairs, frameSize, cameraLayout]);

  // Camera + canvas share the processed frame's aspect ratio, centered —
  // scale-1 mapping, no cover-crop (the letterbox-alignment fix).
  const aspect = frameSize.width / Math.max(1, frameSize.height);
  const view =
    screenW / screenH > aspect
      ? { width: screenH * aspect, height: screenH }
      : { width: screenW, height: screenW / aspect };
  const onCameraLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setCameraLayout({ width, height });
  }, []);

  // 5. Cloud sync (30s, text only) + privacy ledger counters -------------------
  const latestCounts = useRef<Counts>(counts);
  latestCounts.current = counts;
  const pausedRef = useRef(sharingPaused);
  pausedRef.current = sharingPaused;
  const branchRef = useRef(branch);
  branchRef.current = branch;
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [updatesSent, setUpdatesSent] = useState(0);
  const [bytesSent, setBytesSent] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (pausedRef.current) return;
      void syncTelemetryToCloud(branchRef.current, latestCounts.current).then((r) => {
        setLastSync(r);
        if (r.ok) {
          setUpdatesSent((n) => n + 1);
          setBytesSent((b) => b + r.bytes);
        }
      });
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Render -------------------------------------------------------------------
  if (!hasPermission) {
    return (
      <View className="flex-1 items-center justify-center bg-slate-900 px-8">
        <Text className="text-center text-base text-slate-300">
          Camera permission is required for on-device seat detection.
        </Text>
      </View>
    );
  }
  if (device == null) {
    return (
      <View className="flex-1 items-center justify-center bg-slate-900">
        <Text className="text-slate-300">No rear camera found.</Text>
      </View>
    );
  }

  const syncChip =
    plugin.state !== 'loaded'
      ? 'Loading model…'
      : sharingPaused
        ? 'Sharing paused · on-device AI still running'
        : lastSync == null
          ? `Live on map · next update in ${SYNC_INTERVAL_MS / 1000}s`
          : lastSync.ok
            ? `Live on map · synced ${formatTime(lastSync.at)}`
            : 'Cloud offline · on-device AI still running';

  const labelText: Record<ScreenBox['label'], string> = {
    vacantChair: 'chair free',
    chair: 'chair',
    person: 'person',
    laptop: 'laptop',
  };

  return (
    <View className="flex-1 bg-slate-950">
      {/* Full-bleed camera region; the view is aspect-fitted to the frame. */}
      <View style={styles.camArea}>
        <View
          style={[styles.camBox, { width: view.width, height: view.height }]}
          onLayout={onCameraLayout}
        >
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={appActive && cameraOn}
            frameProcessor={frameProcessor}
            pixelFormat="yuv"
            resizeMode="cover"
          />
          <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
            {boxes.map((b, i) => (
              <Rect
                key={`${b.label}-${i}`}
                x={b.x}
                y={b.y}
                width={b.width}
                height={b.height}
                color={b.color}
                style="stroke"
                strokeWidth={1.5}
              />
            ))}
          </Canvas>
          {/* label chips above the Skia canvas */}
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {boxes.map((b, i) => (
              <View
                key={`lbl-${b.label}-${i}`}
                style={[
                  styles.labelChip,
                  {
                    left: Math.max(0, Math.min(b.x, view.width - 60)),
                    top: Math.max(0, b.y - 18),
                    backgroundColor: b.color,
                  },
                ]}
              >
                <Text style={styles.labelText}>{labelText[b.label]}</Text>
              </View>
            ))}
          </View>
          {!cameraOn && (
            <View style={styles.camOff}>
              <Text className="text-sm font-semibold text-slate-300">Camera stopped</Text>
            </View>
          )}
        </View>
      </View>

      {/* Rounded bottom console panel */}
      <View style={styles.panel}>
        <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
          {/* status word + live chip */}
          <View className="mb-2 flex-row items-center justify-between">
            <Text
              className="text-3xl font-extrabold"
              style={{ color: AVAILABILITY_COLOR[telemetry.availability] }}
            >
              {AVAILABILITY_LABEL[telemetry.availability]}
              {telemetry.totalSeats > 0 ? ` · ${telemetry.occupancyPct}%` : ''}
            </Text>
          </View>
          <View className="mb-3 self-start rounded-full bg-emerald-500/15 px-3 py-1">
            <Text className="text-xs font-semibold text-emerald-400">{syncChip}</Text>
          </View>

          {/* seat meter capsule */}
          <View className="rounded-2xl bg-slate-800 p-3">
            <View className="flex-row">
              {(
                [
                  ['Vacant', counts.vacant, COLORS.chair],
                  ['Occupied', counts.occupied, COLORS.person],
                  ['Laptops', counts.laptops, COLORS.laptop],
                ] as const
              ).map(([label, v, color]) => (
                <View key={label} className="flex-1 items-center">
                  <Text className="text-2xl font-extrabold" style={{ color }}>
                    {v}
                  </Text>
                  <Text className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                    {label}
                  </Text>
                </View>
              ))}
            </View>
            <View className="mt-2 h-2 flex-row overflow-hidden rounded-full bg-slate-900">
              {telemetry.totalSeats > 0 && (
                <>
                  <View style={{ flex: counts.occupied, backgroundColor: COLORS.person }} />
                  <View style={{ flex: counts.vacant, backgroundColor: COLORS.chair }} />
                </>
              )}
            </View>
            <Text className="mt-2 text-center text-[11px] text-slate-400">
              Outlet demand: {OUTLET_LABEL[telemetry.outletDemand]} · {branch}
            </Text>
          </View>

          {/* privacy ledger */}
          <View className="mt-3 rounded-2xl bg-slate-800/60 p-3">
            <Text className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Privacy ledger · on-device AI
            </Text>
            <Text className="mt-1 text-xs text-slate-300">
              Updates sent: {updatesSent} · Bytes sent: {bytesSent}
            </Text>
            <Text className="mt-0.5 text-xs text-slate-500">
              Images uploaded: 0 — by design, only 4 numbers leave this phone
            </Text>
          </View>

          {/* controls */}
          <View className="mt-3 flex-row gap-2">
            <View className="flex-1">
              <Chip
                label={sharingPaused ? 'Resume sharing' : 'Pause sharing'}
                active={sharingPaused}
                onPress={() => setSharingPaused((p) => !p)}
              />
            </View>
            <View className="flex-1">
              <Chip
                label={cameraOn ? 'Stop camera' : 'Start camera'}
                active={!cameraOn}
                onPress={() => setCameraOn((c) => !c)}
              />
            </View>
          </View>

          {/* orientation calibration */}
          <View className="mt-3">
            <Text className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Calibrate (fix rotated/mirrored boxes)
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {ROTATIONS.map((r) => (
                <Chip key={r} label={r} active={rotation === r} onPress={() => setRotation(r)} />
              ))}
              <Chip label="Mirror" active={mirror} onPress={() => setMirror((m) => !m)} />
            </View>
          </View>

          {/* cafe picker */}
          <View className="mt-3">
            <Pressable
              onPress={() => setPickerOpen((o) => !o)}
              className="flex-row items-center justify-between rounded-2xl bg-slate-800 px-4 py-3"
            >
              <Text className="text-sm font-semibold text-slate-200">Cafe: {branch}</Text>
              <Text className="text-xs text-slate-400">{pickerOpen ? '▲' : '▼'}</Text>
            </Pressable>
            {pickerOpen && (
              <View className="mt-1 rounded-2xl bg-slate-800 p-2">
                {cafes.map((c) => (
                  <Pressable
                    key={c.branch}
                    onPress={() => {
                      setBranch(c.branch);
                      setPickerOpen(false);
                    }}
                    className="rounded-xl px-3 py-2"
                  >
                    <Text className="text-sm text-slate-200">
                      {c.name}
                      {c.demo ? '  · demo' : ''}
                    </Text>
                  </Pressable>
                ))}
                <TextInput
                  value={manualBranch}
                  onChangeText={setManualBranch}
                  onSubmitEditing={() => {
                    const b = manualBranch.trim().slice(0, 24);
                    if (b) {
                      setBranch(b);
                      setPickerOpen(false);
                    }
                  }}
                  placeholder="Manual branch name…"
                  placeholderTextColor="#64748b"
                  className="mt-1 rounded-xl bg-slate-900 px-3 py-2 text-sm text-slate-200"
                />
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  camArea: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#020617',
  },
  camBox: { overflow: 'hidden', borderRadius: 0 },
  camOff: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#020617',
  },
  labelChip: {
    position: 'absolute',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  labelText: { color: '#020617', fontSize: 8, fontWeight: '700' },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '58%',
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
});
