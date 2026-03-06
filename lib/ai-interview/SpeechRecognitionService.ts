"use client";

type BrowserSpeechRecognitionResult = {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
};

type BrowserSpeechRecognitionEvent = {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserSpeechRecognitionResult>;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  }
}

type Options = {
  lang?: string;
  debug?: boolean;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (code: string) => void;
  onListeningChange?: (value: boolean) => void;
};

export class SpeechRecognitionService {
  private readonly lang: string;
  private readonly debug: boolean;
  private readonly onInterim?: (text: string) => void;
  private readonly onFinal?: (text: string) => void;
  private readonly onError?: (code: string) => void;
  private readonly onListeningChange?: (value: boolean) => void;

  private recognition: BrowserSpeechRecognition | null = null;
  private shouldRestart = false;
  private active = false;
  private startInFlight = false;
  private retryAttempt = 0;
  private retryTimer: number | null = null;
  private lastFinalCombined = "";
  private lastErrorCode: string | null = null;

  constructor(options?: Options) {
    this.lang = options?.lang ?? "en-US";
    this.debug = options?.debug ?? false;
    this.onInterim = options?.onInterim;
    this.onFinal = options?.onFinal;
    this.onError = options?.onError;
    this.onListeningChange = options?.onListeningChange;
  }

  private log(...args: unknown[]) {
    if (!this.debug) {
      return;
    }
    console.log("[ai-speech-recognition]", ...args);
  }

  private clearTimer() {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private ensureRecognition() {
    if (this.recognition) {
      return this.recognition;
    }

    if (typeof window === "undefined") {
      return null;
    }

    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      return null;
    }

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.lang;

    recognition.onstart = () => {
      this.log("started");
      this.active = true;
      this.startInFlight = false;
      this.lastErrorCode = null;
      this.lastFinalCombined = "";
      this.onListeningChange?.(true);
    };

    recognition.onresult = (event) => {
      this.retryAttempt = 0;
      let interim = "";
      let combinedFinal = "";

      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = `${result?.[0]?.transcript ?? ""}`.trim();
        if (!text) {
          continue;
        }

        if (result.isFinal) {
          combinedFinal = `${combinedFinal} ${text}`.trim();
        } else {
          interim = `${interim} ${text}`.trim();
        }
      }

      if (combinedFinal && combinedFinal !== this.lastFinalCombined) {
        const delta = combinedFinal.startsWith(this.lastFinalCombined)
          ? combinedFinal.slice(this.lastFinalCombined.length).trim()
          : combinedFinal;
        if (delta) {
          this.onFinal?.(delta);
        }
        this.lastFinalCombined = combinedFinal;
      }

      this.onInterim?.(interim);
    };

    recognition.onerror = (event) => {
      const code = event.error ?? "unknown";
      this.lastErrorCode = code;
      this.log("error", code);
      this.onError?.(code);

      if (code === "not-allowed" || code === "service-not-allowed") {
        this.shouldRestart = false;
        this.active = false;
        this.startInFlight = false;
        this.onListeningChange?.(false);
        return;
      }

      if (code === "network") {
        this.retryAttempt += 1;
      }
    };

    recognition.onend = () => {
      this.log("ended");
      this.active = false;
      this.startInFlight = false;
      this.onListeningChange?.(false);

      if (!this.shouldRestart) {
        return;
      }

      if (
        this.lastErrorCode === "not-allowed" ||
        this.lastErrorCode === "service-not-allowed"
      ) {
        return;
      }

      const delay =
        this.retryAttempt > 0
          ? Math.min(10_000, 1200 * 2 ** Math.min(this.retryAttempt, 3))
          : 1200;
      this.clearTimer();
      this.retryTimer = window.setTimeout(() => {
        void this.start();
      }, delay);
    };

    this.recognition = recognition;
    return recognition;
  }

  get supported() {
    if (typeof window === "undefined") {
      return false;
    }

    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  async start() {
    const recognition = this.ensureRecognition();
    if (!recognition) {
      this.onError?.("unsupported");
      return false;
    }

    if (this.active || this.startInFlight) {
      this.log("start skipped (already active)");
      return true;
    }

    this.shouldRestart = true;
    this.clearTimer();

    try {
      this.startInFlight = true;
      this.log("start requested");
      recognition.start();
      return true;
    } catch (error) {
      this.startInFlight = false;
      this.onListeningChange?.(false);
      const text = error instanceof Error ? error.message.toLowerCase() : "";
      if (text.includes("network")) {
        this.retryAttempt += 1;
        this.onError?.("network");
      }
      this.onError?.("start-failed");
      return false;
    }
  }

  stop() {
    this.shouldRestart = false;
    this.active = false;
    this.startInFlight = false;
    this.retryAttempt = 0;
    this.lastErrorCode = null;
    this.lastFinalCombined = "";
    this.clearTimer();

    if (!this.recognition) {
      this.onListeningChange?.(false);
      return;
    }

    try {
      this.recognition.stop();
    } catch {
      // no-op
    }

    this.onListeningChange?.(false);
  }

  destroy() {
    this.stop();
    this.recognition = null;
  }
}
