/** Undo / redo: every edit is a change of one value in one layer; a stroke groups the changes of one drag. */
export interface Change { layer: string; key: string; before: unknown; after: unknown }

export class History {
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private open: Change[] | null = null;
  limit = 500;

  /** Start grouping changes (a drag). Nested begins join the outer stroke. */
  begin(): void { if (!this.open) this.open = []; }
  /** Record one change; outside a stroke it is its own step. */
  record(c: Change): void {
    if (c.before === c.after || JSON.stringify(c.before) === JSON.stringify(c.after)) return;
    if (this.open) {
      // keep the oldest "before" of a cell touched twice in one stroke
      const prior = this.open.find((o) => o.layer === c.layer && o.key === c.key);
      if (prior) prior.after = c.after; else this.open.push(c);
    } else this.push([c]);
  }
  end(): boolean {
    const stroke = this.open;
    this.open = null;
    if (!stroke) return false;
    const real = stroke.filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
    if (!real.length) return false;
    this.push(real);
    return true;
  }
  private push(step: Change[]): void {
    this.undoStack.push(step);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  /** The step to revert (newest first), or null. The caller applies each change's `before`. */
  undo(): Change[] | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push(step);
    return step.slice().reverse();
  }
  redo(): Change[] | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push(step);
    return step;
  }
  clear(): void { this.undoStack = []; this.redoStack = []; this.open = null; }
}
