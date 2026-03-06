"use client";

type SpeechSynthesisServiceOptions = {
  pitch?: number;
  rate?: number;
  lang?: string;
  onSpeakingChange?: (speaking: boolean) => void;
};

export class SpeechSynthesisService {
  private readonly pitch: number;
  private readonly rate: number;
  private readonly lang: string;
  private readonly onSpeakingChange?: (speaking: boolean) => void;
  private voicesLoaded = false;

  constructor(options?: SpeechSynthesisServiceOptions) {
    this.pitch = options?.pitch ?? 1;
    this.rate = options?.rate ?? 0.95;
    this.lang = options?.lang ?? "en-US";
    this.onSpeakingChange = options?.onSpeakingChange;

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const voices = window.speechSynthesis.getVoices();
      this.voicesLoaded = voices.length > 0;
      window.speechSynthesis.onvoiceschanged = () => {
        this.voicesLoaded = window.speechSynthesis.getVoices().length > 0;
      };
    }
  }

  get supported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  cancel() {
    if (!this.supported) {
      return;
    }
    window.speechSynthesis.cancel();
    this.onSpeakingChange?.(false);
  }

  speak(text: string): Promise<void> {
    if (!this.supported) {
      return Promise.resolve();
    }

    const value = text.trim();
    if (!value) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(value);
      utterance.lang = this.lang;
      utterance.pitch = this.pitch;
      utterance.rate = this.rate;

      const voices = synth.getVoices();
      const preferredVoice =
        voices.find((voice) => voice.lang.toLowerCase().startsWith(this.lang.toLowerCase())) ??
        voices.find((voice) => voice.lang.toLowerCase().startsWith("en")) ??
        null;

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      utterance.onstart = () => {
        this.onSpeakingChange?.(true);
      };

      utterance.onend = () => {
        this.onSpeakingChange?.(false);
        resolve();
      };

      utterance.onerror = () => {
        this.onSpeakingChange?.(false);
        resolve();
      };

      if (synth.paused) {
        synth.resume();
      }

      synth.cancel();

      // Slight delay improves reliability after cancel on Chrome/WebKit.
      window.setTimeout(() => {
        if (!this.voicesLoaded) {
          synth.getVoices();
        }
        synth.speak(utterance);
      }, 20);
    });
  }
}
