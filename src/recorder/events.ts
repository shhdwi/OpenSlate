/**
 * The structured event log emitted alongside the frame sequence. The
 * compositor uses this for auto-zoom triggers, click bounce timing,
 * cursor anchoring, and caption generation.
 */

export type RecordedEventKind =
  | "navigation"
  | "click"
  | "input"
  | "scroll"
  | "hover"
  | "focus"
  | "type"
  | "wait"
  | "frame_start"
  | "frame_end";

export interface RecordedEvent {
  kind: RecordedEventKind;
  /** ms from start of recording */
  t_ms: number;
  /** viewport-space coordinates, when applicable (clicks, hovers, type, scroll) */
  x?: number;
  y?: number;
  /** CSS selector or URL */
  target?: string;
  /** for input events */
  value?: string;
  /** the plan step index that produced this event, when known */
  step_index?: number;
  /** human-readable note from the plan step (used as caption source in from_steps mode) */
  note?: string;
  /** flag: this is the protagonist click of the demo (drives flourishes/highlights) */
  is_protagonist?: boolean;
  /** suppress polish for this event (e.g., dropdown-dismiss click) */
  no_zoom?: boolean;
  /** flag: this event was emitted synthetically by the recorder, not from a DOM listener */
  synthetic?: boolean;
}

export interface CursorSample {
  /** ms from start of recording */
  t_ms: number;
  /** viewport-space pixel coordinates */
  x: number;
  y: number;
}

export interface RecordingManifest {
  id: string;
  created_at: string;
  duration_ms: number;
  fps: number;
  viewport: { width: number; height: number };
  device_pixel_ratio: number;
  /** Number of frames captured (may differ from frame_indices.length under
   *  race recovery; downstream consumers should prefer frame_indices). */
  frame_count: number;
  /** Sorted list of indices that actually exist on disk in `frames_dir`.
   *  Composition maps timeline frames into this array so missing frames
   *  fall back to the nearest neighbor. */
  frame_indices: number[];
  /** Per-frame recording timestamps (ms from start), aligned 1:1 with
   *  `frame_indices`. CDP screencast is delta-emitted (no frame on static
   *  pages), so frame timing is non-uniform — the compositor binary-searches
   *  this array to map an output time to the correct source frame. */
  frame_timestamps_ms: number[];
  /**
   * Recorder-computed offset into the captured stream where the *visible*
   * portion of the output begins. Trims the page-load / settle period off
   * the head of the demo so the video starts right before the first
   * interaction. Default 0 (no trim).
   * The compositor subtracts this offset from all event/cursor timestamps
   * and from the source-frame mapping so output's t=0 lines up with the
   * "ready to demo" moment.
   */
  start_offset_ms: number;
  /** path relative to recording dir, where frames live (e.g. "frames/") */
  frames_dir: string;
  /** path to events.json relative to recording dir */
  events_file: string;
  /** path to cursor.json relative to recording dir */
  cursor_file: string;
  /** path to the original plan that produced this recording */
  plan_file: string;
  /** the URL that was recorded */
  base_url: string;
}
