/** What a tool is, and what the editor offers it. Tools never touch the DOM or each other; they edit the map through the api. */
import type { Camera } from '../core/camera.js';
import type { AmpMap } from '../core/map.js';
import type { Cell } from '../core/types.js';

export interface EditorState {
  /** The active picker entry. */
  content: string;
  brush: string;
  /** Square brush side in cells. */
  size: number;
  /** The value the brush places (its options - direction, text, scale... - are edited in the Properties panel). */
  draft: unknown;
  /** The active editor layer. */
  layer: string;
  /** The selected placed thing, if any. */
  selection: { layer: string; key: string } | null;
  /** The course (number) the next gate goes to; 0: none yet. */
  course?: number;
}

export interface PointerInfo {
  cell: Cell;
  /** Pixels in the canvas. */
  sx: number;
  sy: number;
  shift: boolean;
  ctrl: boolean;
}

export interface ToolApi {
  map: AmpMap;
  camera: Camera;
  state: EditorState;
  /** Change one value of a layer as part of the current undo step. */
  edit(layer: string, key: string, value: unknown): void;
  /** Group everything edited until endStroke into one undo step. */
  beginStroke(): void;
  endStroke(): void;
  redraw(): void;
  /** Pick a brush (the eyedropper); `value` is the placed value it was picked from (keeps its options). */
  setBrush(content: string, brush: string, value?: unknown): void;
  /** The data layer a content type is placed in right now (null: that layer is locked or hidden). */
  layerFor(content: string): string | null;
  /** Select a placed thing (or nothing). */
  select(sel: { layer: string; key: string } | null): void;
  /** Switch the active editor layer. */
  setLayer(id: string): void;
  /** Switch tool by id. */
  setTool(id: string): void;
}

export interface Tool {
  id: string;
  label: string;
  /** Single key (upper case) that selects the tool. */
  hotkey: string;
  cursor: string;
  /** One line shown in the status bar while active. */
  hint: string;
  activate?(api: ToolApi): void;
  deactivate?(api: ToolApi): void;
  down(api: ToolApi, p: PointerInfo): void;
  move?(api: ToolApi, p: PointerInfo, pressed: boolean): void;
  up?(api: ToolApi, p: PointerInfo): void;
  /** Extra drawing over the map (a footprint, a rubber band), in screen space. */
  overlay?(api: ToolApi, ctx: CanvasRenderingContext2D, hover: Cell | null): void;
}
