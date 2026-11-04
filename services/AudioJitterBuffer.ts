export interface VoiceFrame {
  frameNumber: number;
  codec: 'opus';
  data: string;
  sessionId: string;
}

/** Local monotonic arrival times only; never subtract clocks on different phones. */
export class AudioJitterBuffer {
  private frames = new Map<number, { frame: VoiceFrame; arrived: number }>();
  private next: number | null = null;
  private readyAt = 0;
  readonly stats = { received: 0, late: 0, duplicate: 0, dropped: 0, missing: 0 };
  constructor(readonly targetMs = 60, readonly maxMs = 120) {}

  push(frame: VoiceFrame, now: number) {
    this.stats.received++;
    if (this.next !== null && frame.frameNumber < this.next) { this.stats.late++; return; }
    if (this.frames.has(frame.frameNumber)) { this.stats.duplicate++; return; }
    if (this.next === null) { this.next = frame.frameNumber; this.readyAt = now + this.targetMs; }
    this.frames.set(frame.frameNumber, { frame, arrived: now });
    // A burst must not turn into seconds of queued conversation.
    if (this.frames.size > this.maxMs / 20) {
      const keepFrom = frame.frameNumber - Math.ceil(this.targetMs / 20) + 1;
      for (const n of this.frames.keys()) {
        if (n < keepFrom) { this.frames.delete(n); this.stats.dropped++; }
      }
      this.next = Math.max(this.next, keepFrom);
    }
  }

  /** undefined = rebuffer/idle, null = one missing 20ms frame, otherwise next packet. */
  pop(now: number): VoiceFrame | null | undefined {
    if (this.next === null || now < this.readyAt) return undefined;
    for (const [n, entry] of this.frames) {
      if (now - entry.arrived > this.maxMs) { this.frames.delete(n); this.stats.dropped++; }
    }
    if (this.frames.size === 0) { this.next = null; return undefined; }
    // Skip a large sequence hole instead of playing a long run of silence.
    const first = Math.min(...this.frames.keys());
    if (first - this.next > this.maxMs / 20) {
      this.stats.missing += first - this.next;
      this.next = first;
    }
    const entry = this.frames.get(this.next);
    this.frames.delete(this.next++);
    if (!entry) { this.stats.missing++; return null; }
    return entry.frame;
  }
  get queueMs() { return this.frames.size * 20; }
}
