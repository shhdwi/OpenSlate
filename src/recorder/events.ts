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
  | "wait"
  | "frame_start"
  | "frame_end";

export interface RecordedEvent {
  kind: RecordedEventKind;
  /** ms from start of recording */
  t_ms: number;
  /** viewport-space coordinates, when applicable (clicks, hovers) */
  x?: number;
  y?: number;
  /** CSS selector or URL */
  target?: string;
  /** for input events */
  value?: string;
  /** the plan step index that produced this event, when known */
  step_index?: number;
  /** flag: this is the protagonist click of the demo (drives flourishes/highlights) */
  is_protagonist?: boolean;
  /** suppress polish for this event (e.g., dropdown-dismiss click) */
  no_zoom?: boolean;
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
