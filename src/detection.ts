// src/detection.ts
// Pure helpers for parsing SSD MobileNet v1 output, counting seats, and
// mapping normalized boxes onto the on-screen camera preview.

export type Label = 'person' | 'chair' | 'laptop';

/** Normalized box (0..1) in *portrait* frame space. */
export interface Detection {
  label: Label;
  score: number;
  x: number; // left
  y: number; // top
  w: number;
  h: number;
}

export interface Counts {
  vacant: number;
  occupied: number;
  laptops: number;
}

export interface ScreenBox {
  label: Label | 'vacantChair';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export const MODEL_INPUT_SIZE = 300;
export const SCORE_THRESHOLD = 0.5;
export const INFERENCE_INTERVAL_MS = 500;

/**
 * COCO ids (91-class label map): person=1, chair=62, laptop=73.
 * The TFLite SSD MobileNet v1 sample model emits ids shifted by one
 * (the "???" entry at index 0 of labelmap.txt is dropped), so we add
 * CLASS_ID_OFFSET back before comparing. If your export already emits raw
 * COCO ids, set this to 0.
 */
export const CLASS_ID_OFFSET = 1;
const COCO_PERSON = 1;
const COCO_CHAIR = 62;
const COCO_LAPTOP = 73;

export const COLORS = {
  chair: '#10B981', // emerald - vacant chair
  person: '#F59E0B', // amber - occupied seat
  laptop: '#06B6D4', // cyan - workstation
} as const;

/**
 * Parses the 4 output tensors of ssd_mobilenet_v1:
 *   [0] boxes   [1,N,4]  (ymin, xmin, ymax, xmax), normalized
 *   [1] classes [1,N]
 *   [2] scores  [1,N]
 *   [3] count   [1]
 * Runs inside the frame-processor worklet.
 */
export function parseDetections(
  boxes: Float32Array,
  classes: Float32Array,
  scores: Float32Array,
  count: number
): Detection[] {
  'worklet';
  const out: Detection[] = [];
  const n = Math.min(count, scores.length);
  for (let i = 0; i < n; i++) {
    const score = scores[i];
    if (score < SCORE_THRESHOLD) continue;

    const cocoId = Math.round(classes[i]) + CLASS_ID_OFFSET;
    let label: Label | null = null;
    if (cocoId === COCO_PERSON) label = 'person';
    else if (cocoId === COCO_CHAIR) label = 'chair';
    else if (cocoId === COCO_LAPTOP) label = 'laptop';
    if (label === null) continue;

    const ymin = Math.max(0, Math.min(1, boxes[i * 4]));
    const xmin = Math.max(0, Math.min(1, boxes[i * 4 + 1]));
    const ymax = Math.max(0, Math.min(1, boxes[i * 4 + 2]));
    const xmax = Math.max(0, Math.min(1, boxes[i * 4 + 3]));

    out.push({ label, score, x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin });
  }
  return out;
}

/** Fraction of box `a` that is covered by box `b`. */
function overlapRatio(a: Detection, b: Detection): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const area = a.w * a.h;
  return area > 0 ? (ix * iy) / area : 0;
}

const OCCUPIED_OVERLAP = 0.25;

/** Splits chairs into vacant vs. covered by a person and returns the KPIs. */
export function computeCounts(detections: Detection[]): {
  counts: Counts;
  vacantChairs: Detection[];
} {
  const persons = detections.filter((d) => d.label === 'person');
  const chairs = detections.filter((d) => d.label === 'chair');
  const laptops = detections.filter((d) => d.label === 'laptop');

  const vacantChairs = chairs.filter(
    (c) => !persons.some((p) => overlapRatio(c, p) > OCCUPIED_OVERLAP)
  );

  return {
    counts: {
      vacant: vacantChairs.length,
      occupied: persons.length,
      laptops: laptops.length,
    },
    vacantChairs,
  };
}

/**
 * Maps a normalized box to canvas pixels. The camera view and the Skia
 * canvas are sized to the *processed frame's* aspect ratio (see App.tsx),
 * so this is a plain scale-1 mapping — no cover-crop math, and letterbox
 * alignment errors are impossible by construction.
 */
export function mapToScreen(
  d: Detection,
  frameW: number,
  frameH: number,
  viewW: number,
  viewH: number
): { x: number; y: number; width: number; height: number } {
  const scaleX = viewW / frameW;
  const scaleY = viewH / frameH;
  return {
    x: d.x * scaleX,
    y: d.y * scaleY,
    width: d.w * scaleX,
    height: d.h * scaleY,
  };
}