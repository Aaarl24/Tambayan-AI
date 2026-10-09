// App.tsx
import './global.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
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
} from './src/detection';
import { BRANCH_NAME, SYNC_INTERVAL_MS } from './src/config';
import { syncTelemetryToCloud, type SyncResult } from './src/cloud';
import {
  AVAILABILITY_COLOR,
  AVAILABILITY_LABEL,
  OUTLET_LABEL,
  deriveTelemetry,
} from './src/telemetry';

interface FrameSize {
  width: number;
  height: number;
}

function KpiCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}): React.JSX.Element {
  return (
    <View className="flex-1 items-center rounded-2xl bg-slate-800 py-3 mx-1">
      <Text style={{ color }} className="text-5xl font-extrabold">
        {value}
      </Text>
      <Text className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </Text>
    </View>
  );
}

const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function App(): React.JSX.Element {
  // 1. Hardware & model initialization ---------------------------------------
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  useEffect(() => {
    if (!hasPermission) {
      void requestPermission();
    }
  }, [hasPermission, requestPermission]);

  const plugin = useTensorflowModel(require('./assets/ssd_mobilenet_v1.tflite'));
  const model = plugin.state === 'loaded' ? plugin.model : undefined;
  const { resize } = useResizePlugin();

  // fast-tflite v3 models are Nitro "hybrid objects". Vision Camera v4 runs
  // frame processors on react-native-worklets-core, so the model must be
  // boxed here and unboxed inside the worklet to cross threads safely.
  const boxedModel = useMemo(() => (model != null ? NitroModules.box(model) : undefined), [model]);

  // Dev aid: confirm you loaded the right model (expect input uint8 [1,300,300,3]
  // and 4 outputs: boxes, classes, scores, count).
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

  // 2. Frame processor -> JS thread bridge -----------------------------------
  const [detections, setDetections] = useState<Detection[]>([]);
  const [frameSize, setFrameSize] = useState<FrameSize>({ width: 3, height: 4 });
  const [cameraLayout, setCameraLayout] = useState<FrameSize>({ width: 0, height: 0 });

  // Shared value used on the worklet thread for the 500ms throttle.
  // (Vision Camera v4 runs worklets on react-native-worklets-core, so shared
  // values must come from there; Reanimated shared values cannot cross.)
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

      // runAsync keeps inference off the camera thread (frames are dropped
      // while busy); the timestamp gate limits it to ~1 run per 500ms.
      runAsync(frame, () => {
        'worklet';
        const now = Date.now();
        if (now - lastInferenceMs.value < INFERENCE_INTERVAL_MS) return;
        lastInferenceMs.value = now;

        // Resize to the model's 300x300 uint8 RGB input. '90deg' rotates the
        // landscape sensor buffer into portrait so boxes line up with the
        // portrait UI. If boxes look rotated on a device, adjust this value.
        const input = resize(frame, {
          scale: { width: MODEL_INPUT_SIZE, height: MODEL_INPUT_SIZE },
          pixelFormat: 'rgb',
          dataType: 'uint8',
          rotation: '90deg',
        });

        // fast-tflite v3 takes and returns raw ArrayBuffers, one per tensor.
        const model = boxedModel.unbox();
        const outputs = model.runSync([input.buffer as ArrayBuffer]);
        const boxes = new Float32Array(outputs[0]);
        const classes = new Float32Array(outputs[1]);
        const scores = new Float32Array(outputs[2]);
        const count = Math.round(new Float32Array(outputs[3])[0]);

        const found = parseDetections(boxes, classes, scores, count);

        // Portrait frame dims (the buffer is landscape; we rotated it).
        const fw = Math.min(frame.width, frame.height);
        const fh = Math.max(frame.width, frame.height);
        handleResultsOnJS(found, fw, fh);
      });
    },
    [boxedModel, resize, lastInferenceMs, handleResultsOnJS]
  );

  // 3. Derived counts, edge telemetry and Skia boxes -------------------------
  const { counts, vacantChairs } = useMemo(() => computeCounts(detections), [detections]);
  const telemetry = useMemo(() => deriveTelemetry(counts), [counts]);

  const boxes = useMemo<ScreenBox[]>(() => {
    if (cameraLayout.width === 0 || cameraLayout.height === 0) return [];
    const project = (d: Detection) =>
      mapToScreen(d, frameSize.width, frameSize.height, cameraLayout.width, cameraLayout.height);

    const out: ScreenBox[] = [];
    for (const d of vacantChairs) {
      out.push({ label: 'vacantChair', color: COLORS.chair, ...project(d) });
    }
    for (const d of detections) {
      if (d.label === 'person') out.push({ label: 'person', color: COLORS.person, ...project(d) });
      else if (d.label === 'laptop') out.push({ label: 'laptop', color: COLORS.laptop, ...project(d) });
    }
    return out;
  }, [detections, vacantChairs, frameSize, cameraLayout]);

  const onCameraLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setCameraLayout({ width, height });
  }, []);

  // 5. Cloud telemetry sync (every 30s, text only) ---------------------------
  const latestCounts = useRef<Counts>(counts);
  latestCounts.current = counts;
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      void syncTelemetryToCloud(BRANCH_NAME, latestCounts.current).then(setLastSync);
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

  const syncLine =
    lastSync == null
      ? `Next cloud update in ${SYNC_INTERVAL_MS / 1000}s · text only, no images`
      : lastSync.ok
        ? `Cloud synced ${formatTime(lastSync.at)} · ${lastSync.bytes} bytes, no images`
        : 'Cloud offline · on-device AI still running';

  return (
    <View className="flex-1 bg-slate-900">
      {/* Top 65%: live camera + Skia overlay */}
      <View className="flex-[65] overflow-hidden" onLayout={onCameraLayout}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive
          frameProcessor={frameProcessor}
          pixelFormat="yuv"
          resizeMode="cover"
          fps={30}
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
              strokeWidth={2}
            />
          ))}
        </Canvas>
      </View>

      {/* Bottom 35%: telemetry dashboard */}
      <View className="flex-[35] justify-center bg-slate-900 px-3">
        <View className="mb-3 self-center rounded-full bg-emerald-500/15 px-4 py-1.5">
          <Text className="text-sm font-semibold text-emerald-400">⚡ 100% On-Device AI Active</Text>
        </View>

        <View className="flex-row">
          <KpiCard label="Vacant Chairs" value={counts.vacant} color={COLORS.chair} />
          <KpiCard label="Occupied Seats" value={counts.occupied} color={COLORS.person} />
          <KpiCard label="Active Laptops" value={counts.laptops} color={COLORS.laptop} />
        </View>

        {/* One glanceable line: capacity status + outlet demand */}
        <View className="mt-3 flex-row items-center justify-between px-2">
          <Text style={{ color: AVAILABILITY_COLOR[telemetry.availability] }} className="text-base font-bold">
            {AVAILABILITY_LABEL[telemetry.availability]}
            {telemetry.totalSeats > 0 ? ` · ${telemetry.occupancyPct}% full` : ''}
          </Text>
          <Text className="text-sm font-semibold text-slate-300">
            Outlet demand: {OUTLET_LABEL[telemetry.outletDemand]}
          </Text>
        </View>

        <Text className="mt-2 text-center text-xs text-slate-500">
          {plugin.state === 'loaded' ? `${BRANCH_NAME} · ${syncLine}` : 'Loading model…'}
        </Text>
      </View>
    </View>
  );
}