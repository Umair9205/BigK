export type CallState =
  | 'idle'
  | 'discovery'
  | 'connecting'
  | 'handshake'
  | 'acknowledged'
  | 'streaming'
  | 'ending'
  | 'error';

interface CallSession {
  sessionId: string;
  peerUUID: string;
  peerConnectionId: string;
  startTime: number;
  state: CallState;
  codec: string;
}

/**
 * Manages call state machine and transitions
 */
export class CallStateManager {
  private state: CallState = 'idle';
  private sessionId: string = '';
  private peerUUID: string = '';
  private peerConnectionId: string = '';
  private startTime: number = 0;
  private codec: string = 'opus';
  private listeners: Set<(state: CallState) => void> = new Set();

  /**
   * Get current state
   */
  getState(): CallState {
    return this.state;
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get full session data
   */
  getSession(): CallSession {
    return {
      sessionId: this.sessionId,
      peerUUID: this.peerUUID,
      peerConnectionId: this.peerConnectionId,
      startTime: this.startTime,
      state: this.state,
      codec: this.codec,
    };
  }

  /**
   * Initialize call session
   */
  initSession(sessionId: string, peerUUID: string, peerConnectionId: string): void {
    this.sessionId = sessionId;
    this.peerUUID = peerUUID;
    this.peerConnectionId = peerConnectionId;
    this.startTime = Date.now();
    // Force back to idle first: a new call session must always start a
    // fresh state walk, even if a previous session left this manager in a
    // non-idle state (e.g. a call that ended without going through 'ending'
    // in the rare case cleanup ran out of order).
    this.state = 'idle';
    this.setState('discovery');
  }

  /**
   * Transition to new state with validation
   */
  setState(newState: CallState): boolean {
    if (!this.isValidTransition(this.state, newState)) {
      console.warn(`Invalid transition: ${this.state} -> ${newState}`);
      return false;
    }

    const oldState = this.state;
    this.state = newState;

    console.log(`[CallState] ${oldState} -> ${newState}`);
    this.notifyListeners(newState);

    return true;
  }

  /**
   * Check if transition is valid
   */
  isValidTransition(from: CallState, to: CallState): boolean {
    // Kela-Konnect's actual call screens (app/call.tsx, app/incoming-call.tsx)
    // don't emit every intermediate state — both the caller and callee go
    // straight from 'discovery' to 'streaming' once audio setup succeeds,
    // skipping 'connecting' / 'handshake' / 'acknowledged' as explicit
    // setState() calls (those states exist for finer-grained UI/analytics
    // use, but aren't mandatory waypoints). The table below reflects the
    // actual transitions this app produces, in addition to the granular
    // path, so setState() calls from real screens don't get silently
    // rejected and leave getState() permanently stuck reporting a stale
    // state for the rest of the call.
    const validTransitions: Record<CallState, CallState[]> = {
      idle: ['discovery'],
      discovery: ['connecting', 'handshake', 'streaming', 'error', 'idle'],
      connecting: ['handshake', 'streaming', 'error', 'idle'],
      handshake: ['acknowledged', 'streaming', 'error', 'idle'],
      acknowledged: ['streaming', 'error', 'idle'],
      streaming: ['ending', 'error', 'idle'],
      ending: ['idle'],
      error: ['idle'],
    };

    const allowed = validTransitions[from] || [];
    return allowed.includes(to);
  }

  /**
   * Set codec (for handshake)
   */
  setCodec(codec: string): void {
    this.codec = codec;
  }

  /**
   * Get duration in seconds
   */
  getDurationInSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: CallState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reset session data back to idle at the end of a call.
   *
   * Deliberately does NOT clear `listeners`: this manager is a singleton
   * used across the whole app lifetime, so a subscriber registered once
   * (e.g. at app start) must keep receiving updates for every subsequent
   * call, not just the first one. Clearing listeners here previously meant
   * any such subscriber silently stopped getting notified after the very
   * first call ended.
   */
  reset(): void {
    const changed = this.state !== 'idle';
    this.state = 'idle';
    this.sessionId = '';
    this.peerUUID = '';
    this.peerConnectionId = '';
    this.startTime = 0;
    if (changed) this.notifyListeners('idle');
  }

  // ============= Private =============

  private notifyListeners(state: CallState): void {
    this.listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (e) {
        console.error('Listener error:', e);
      }
    });
  }
}

// Singleton instance
export const callStateManager = new CallStateManager();
