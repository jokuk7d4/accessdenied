"use client";

type ViolationType = "LOOK_LEFT" | "LOOK_RIGHT" | "LOOK_DOWN" | "MULTIPLE_WARNINGS";

export type ProctoringViolation = {
  type: ViolationType;
  durationSec: number;
  timestamp: string;
};

type FaceLandmarkerInstance = {
  detectForVideo: (
    video: HTMLVideoElement,
    timestampMs: number,
  ) => {
    faceLandmarks?: Array<Array<{ x: number; y: number; z: number }>>;
  };
  close: () => void;
};

type Options = {
  fps?: number;
  debug?: boolean;
  onViolation?: (event: ProctoringViolation) => void;
};

const LOOK_AWAY_THRESHOLD_MS = 3000;

export class ProctoringService {
  private readonly fps: number;
  private readonly debug: boolean;
  private readonly onViolation?: (event: ProctoringViolation) => void;

  private running = false;
  private loopTimer: number | null = null;
  private landmarker: FaceLandmarkerInstance | null = null;
  private videoEl: HTMLVideoElement | null = null;

  private currentDirection: "CENTER" | "LEFT" | "RIGHT" | "DOWN" = "CENTER";
  private directionSince = 0;
  private emittedForDirection = false;
  private warningCount = 0;

  constructor(options?: Options) {
    this.fps = Math.max(1, Math.min(10, options?.fps ?? 10));
    this.debug = options?.debug ?? false;
    this.onViolation = options?.onViolation;
  }

  private log(...args: unknown[]) {
    if (!this.debug) {
      return;
    }

    console.log("[ai-proctoring]", ...args);
  }

  private emitViolation(type: ViolationType, durationMs: number) {
    const payload: ProctoringViolation = {
      type,
      durationSec: Math.max(1, Math.round(durationMs / 1000)),
      timestamp: new Date().toISOString(),
    };
    this.log("violation", payload);
    this.onViolation?.(payload);
  }

  async init(videoEl: HTMLVideoElement) {
    this.videoEl = videoEl;

    if (typeof window === "undefined") {
      throw new Error("Proctoring is only available in the browser");
    }

    const tasksVision = await import("@mediapipe/tasks-vision");
    const resolver = await tasksVision.FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    );

    const landmarker = await tasksVision.FaceLandmarker.createFromOptions(resolver, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      },
      runningMode: "VIDEO",
      numFaces: 1,
    });

    this.landmarker = landmarker as FaceLandmarkerInstance;
  }

  private classifyDirection(points: Array<{ x: number; y: number; z: number }>) {
    const nose = points[1];
    const leftEyeOuter = points[33];
    const rightEyeOuter = points[263];

    if (!nose || !leftEyeOuter || !rightEyeOuter) {
      return "CENTER" as const;
    }

    const eyeMidX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
    const eyeMidY = (leftEyeOuter.y + rightEyeOuter.y) / 2;
    const eyeDistance = Math.max(Math.abs(rightEyeOuter.x - leftEyeOuter.x), 0.001);

    const normalizedX = (nose.x - eyeMidX) / eyeDistance;
    const normalizedY = nose.y - eyeMidY;

    if (normalizedX < -0.18) {
      return "LEFT" as const;
    }

    if (normalizedX > 0.18) {
      return "RIGHT" as const;
    }

    if (normalizedY > 0.12) {
      return "DOWN" as const;
    }

    return "CENTER" as const;
  }

  private evaluateDirection(direction: "CENTER" | "LEFT" | "RIGHT" | "DOWN") {
    const now = Date.now();

    if (direction !== this.currentDirection) {
      this.currentDirection = direction;
      this.directionSince = now;
      this.emittedForDirection = false;
      return;
    }

    if (direction === "CENTER") {
      return;
    }

    const duration = now - this.directionSince;

    if (duration < LOOK_AWAY_THRESHOLD_MS || this.emittedForDirection) {
      return;
    }

    this.emittedForDirection = true;
    this.warningCount += 1;

    if (direction === "LEFT") {
      this.emitViolation("LOOK_LEFT", duration);
    } else if (direction === "RIGHT") {
      this.emitViolation("LOOK_RIGHT", duration);
    } else {
      this.emitViolation("LOOK_DOWN", duration);
    }

    if (this.warningCount >= 3) {
      this.emitViolation("MULTIPLE_WARNINGS", duration);
      this.warningCount = 0;
    }
  }

  start() {
    if (this.running || !this.landmarker || !this.videoEl) {
      return;
    }

    this.running = true;
    const intervalMs = Math.max(100, Math.floor(1000 / this.fps));

    this.loopTimer = window.setInterval(() => {
      if (!this.landmarker || !this.videoEl || this.videoEl.readyState < 2) {
        return;
      }

      const result = this.landmarker.detectForVideo(this.videoEl, performance.now());
      const points = result.faceLandmarks?.[0];

      if (!points) {
        this.evaluateDirection("CENTER");
        return;
      }

      const direction = this.classifyDirection(points);
      this.evaluateDirection(direction);
    }, intervalMs);
  }

  stop() {
    this.running = false;

    if (this.loopTimer !== null) {
      window.clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
  }

  destroy() {
    this.stop();

    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch {
        // no-op
      }
    }

    this.landmarker = null;
    this.videoEl = null;
  }
}
