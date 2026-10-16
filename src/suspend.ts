/**
 * Tracks system suspend time by comparing wall-clock progress against the
 * monotonic clock, which stops while the machine is suspended.
 *
 * Node timers run on the monotonic clock, so background refresh loops freeze
 * during suspend — correct, nothing is broken. But staleness consumers (the
 * watchdog, the metrics panel) measure lag in wall time, so after a long
 * lid-close every provider looks hours stale even though the process was
 * simply asleep with the rest of the machine. suspendedSince() lets callers
 * discount the asleep intervals and keep staleness meaning "unrefreshed while
 * awake".
 *
 * Drift is detected by sampling both clocks: when the wall clock jumps
 * forward further than the monotonic clock did, the difference is time the
 * system spent suspended. NTP step corrections are absorbed by the slack.
 */

/** Wall-vs-mono gaps below this are clock noise (NTP steps), not suspend. */
const SUSPEND_SLACK_MS = 30_000;

/** Bound the marker history; one entry per detected suspend is plenty. */
const MAX_MARKERS = 100;

interface SuspendMarker {
  /** Wall time of the first sample that saw this suspend's drift. */
  atWall: number;
  /** Total suspend ms accumulated as of this marker. */
  totalMs: number;
}

export class SuspendTracker {
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly markers: SuspendMarker[] = [];
  private totalMs = 0;
  private lastWall = 0;
  private lastMono = 0;
  private sampled = false;

  // Arrow defaults, not bare Date.now/performance.now: a bare method
  // reference loses its receiver when called as this.mono() and throws
  // ERR_INVALID_THIS (performance.now requires its Performance object).
  constructor(wall: () => number = () => Date.now(), mono: () => number = () => performance.now()) {
    this.wall = wall;
    this.mono = mono;
  }

  /** Record a clock sample; a wall-vs-mono gap beyond the slack is suspend. */
  sample(): void {
    const wall = this.wall();
    const mono = this.mono();

    if (this.sampled) {
      const drift = wall - this.lastWall - (mono - this.lastMono);

      if (drift > SUSPEND_SLACK_MS) {
        this.totalMs += drift;
        this.markers.push({ atWall: wall, totalMs: this.totalMs });

        if (this.markers.length > MAX_MARKERS) {
          this.markers.splice(0, this.markers.length - MAX_MARKERS);
        }
      }
    }

    this.sampled = true;
    this.lastWall = wall;
    this.lastMono = mono;
  }

  /**
   * Suspend ms accumulated after a wall-clock stamp, so subtracting it from a
   * wall-clock lag yields awake time. Metric stamps never fall inside a
   * suspend interval (no fetch completes while frozen), so a marker's atWall
   * cleanly separates "before" from "after" for real callers.
   */
  suspendedSince(ts: number): number {
    let base = 0;

    for (const marker of this.markers) {
      if (marker.atWall <= ts) {
        base = marker.totalMs;
      }
    }

    return Math.max(this.totalMs - base, 0);
  }
}
