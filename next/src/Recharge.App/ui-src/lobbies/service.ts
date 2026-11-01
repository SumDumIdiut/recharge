/** Talks to lobbies.* while the page is open: polls the app's cached list and keeps the watch alive. */
import { call, describeError } from '../bridge.js';
import { joinRequest, normalizeReply, type LobbyReply } from './model.js';

export const POLL_MS = 2000;
export const KEEPALIVE_MS = 8000;

export interface PollerHandlers {
  onReply(reply: LobbyReply): void;
  onFailure(message: string): void;
}

export class LobbyPoller {
  private timer = 0;
  private keep = 0;
  private running = false;
  private busy = false;

  private readonly handlers: PollerHandlers;

  constructor(handlers: PollerHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.watch(true);
    this.keep = window.setInterval(() => void this.watch(true), KEEPALIVE_MS);
    void this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    window.clearTimeout(this.timer);
    window.clearInterval(this.keep);
    void this.watch(false);
  }

  /** Fetch now (the Retry button). */
  refresh(): void {
    window.clearTimeout(this.timer);
    void this.tick();
  }

  private async watch(on: boolean): Promise<void> {
    try { await call('lobbies.watch', { on }); } catch { /* the next poll reports the problem */ }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const raw = await call<unknown>('lobbies.list', {});
      if (this.running) this.handlers.onReply(normalizeReply(raw));
    } catch (error) {
      if (this.running) this.handlers.onFailure(describeError(error));
    } finally {
      this.busy = false;
      if (this.running) this.timer = window.setTimeout(() => void this.tick(), POLL_MS);
    }
  }
}

/** Starts the game and joins the lobby (game.launch with a lobby.join intent). Resolves to the text the button shows afterwards. */
export async function joinLobby(lobbyId: number): Promise<string> {
  try {
    await call('game.launch', joinRequest(lobbyId));
    return 'Game starting…';
  } catch (error) {
    return describeError(error).slice(0, 40) || 'Could not start';
  }
}
