import Nearby from '../modules/Nearby';
import { Friend } from '../store/appStore';

export interface DiscoveredFriend extends Friend {
  connectionId: string;
  discovered: boolean;
  lastSeen: Date;
}

/**
 * Presence grace window.
 *
 * Nearby fires onEndpointLost on transient signal dips and emits nothing at
 * all while scanning pauses between calls (e.g. during every dial, when
 * discovery stops before connect). The old behaviour deleted the contact in
 * both cases, and every fresh start wiped the whole cache, so each dial paid
 * for a cold radio scan even when the other phone had been seen seconds
 * earlier.
 *
 * A lost contact therefore lingers for the grace window so the UI can show
 * honest presence and a stop/start cycle can reuse a still-valid endpoint.
 * The endpoint id itself is dropped the moment Nearby invalidates it
 * (lost/closed): a dialer must never receive a dead address.
 */
const PRESENCE_GRACE_MS = 45_000;

/**
 * Manages continuous peer discovery using Nearby Connections
 */
export class NearbyDiscoveryService {
  private isActive = false;
  private generation = 0;
  private friendUUIDs: string[] = [];
  private subscriptions: { remove: () => void }[] = [];
  private discoveredFriends = new Map<string, DiscoveredFriend>();
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners: Set<(friend: DiscoveredFriend) => void> = new Set();

  isScanning() { return this.isActive; }

  /**
   * Immediate removal of a contact from the presence cache. Dial error paths
   * use this to force a genuinely fresh scan for a known-bad endpoint.
   * Without `connectionId` every entry for the uuid is removed; with it, only
   * a matching endpoint is removed (a replacement mapping survives).
   */
  forget(uuid: string, connectionId?: string) {
    const friend = this.discoveredFriends.get(uuid);
    if (!friend || (connectionId && friend.connectionId !== connectionId)) return;
    this.remove(uuid);
  }

  /**
   * Start continuous discovery loop
   */
  async startContinuousDiscovery(friends: Friend[]): Promise<void> {
    if (this.isActive) {
      this.friendUUIDs = friends.map(f => f.uuid);
      const ticket = this.generation;
      if (await Nearby.startDiscovery(this.friendUUIDs) === false && ticket === this.generation) {
        // Native refused to scan: a cached peer must not be shown as reachable.
        this.isActive = false;
        this.discoveredFriends.forEach((_, uuid) => this.forget(uuid));
      }
      return;
    }

    const ticket = ++this.generation;
    this.isActive = true;
    this.friendUUIDs = friends.map((f) => f.uuid);
    // Keep the warm cache across restarts; expire only what outlived the
    // grace window. Every restart used to wipe the cache, which turned each
    // post-call dial back into a cold scan.
    const cutoff = Date.now() - PRESENCE_GRACE_MS;
    this.discoveredFriends.forEach((friend, uuid) => {
      if (friend.lastSeen.getTime() < cutoff) this.forget(uuid);
    });

    // Setup event listeners
    if (!this.subscriptions.length) this.setupEventListeners();

    try {
      if (await Nearby.startDiscovery(this.friendUUIDs) === false && ticket === this.generation) {
        this.isActive = false;
        this.discoveredFriends.forEach((_, uuid) => this.forget(uuid));
      }
    } catch (error) {
      if (ticket === this.generation) await this.stopDiscovery();
      throw error;
    }
  }

  /**
   * Stop continuous discovery loop.
   * Presence entries survive: discovery stops around every dial and restarts
   * afterwards, so wiping here would defeat the warm cache. Entries flip to
   * not-currently-discovered without an event — subscribers read current
   * state when they attach, and stopping is routine, not news.
   */
  async stopDiscovery(): Promise<void> {
    this.generation++;
    this.isActive = false;

    this.discoveredFriends.forEach((friend, uuid) => {
      if (friend.discovered) this.discoveredFriends.set(uuid, { ...friend, discovered: false });
    });

    // Stop discovery at module level
    try {
      await Nearby.stopDiscovery();
    } catch (e) {
      console.error('Stop discovery error:', e);
    }
  }

  /**
   * Get all known contacts (live and within the grace window)
   */
  getDiscoveredFriends(): DiscoveredFriend[] {
    return Array.from(this.discoveredFriends.values());
  }

  /**
   * Subscribe to friend discovery events
   */
  onFriendDiscovered(listener: (friend: DiscoveredFriend) => void): () => void {
    this.listeners.add(listener);
    this.discoveredFriends.forEach(friend => listener(friend));
    return () => this.listeners.delete(listener);
  }

  /**
   * Is the contact visible to the scanner right now (not merely cached)?
   */
  isDiscovered(uuid: string): boolean {
    return this.discoveredFriends.get(uuid)?.discovered === true;
  }

  /**
   * Get a *currently valid* connection ID for a discovered contact.
   * Returns null for grace-only entries whose endpoint Nearby invalidated.
   */
  getConnectionId(uuid: string): string | null {
    return this.discoveredFriends.get(uuid)?.connectionId || null;
  }

  // ============= Private =============

  private remove(uuid: string) {
    this.cancelGrace(uuid);
    const friend = this.discoveredFriends.get(uuid);
    if (!friend) return;
    this.discoveredFriends.delete(uuid);
    this.notifyListeners({ ...friend, discovered: false });
  }

  private cancelGrace(uuid: string) {
    const timer = this.graceTimers.get(uuid);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.graceTimers.delete(uuid);
  }

  private scheduleGrace(uuid: string) {
    if (this.graceTimers.has(uuid)) return;
    const timer = setTimeout(() => {
      this.graceTimers.delete(uuid);
      // A re-discovery refreshes the entry and cancels this timer; only an
      // entry still marked lost expires.
      const friend = this.discoveredFriends.get(uuid);
      if (friend && !friend.discovered) this.remove(uuid);
    }, PRESENCE_GRACE_MS);
    // Node test runners must not wait out pending grace timers. React Native
    // timers are plain numbers and skip this path.
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
    this.graceTimers.set(uuid, timer);
  }

  private findByConnection(connectionId: string): DiscoveredFriend | undefined {
    if (!connectionId) return undefined;
    let match: DiscoveredFriend | undefined;
    this.discoveredFriends.forEach(friend => {
      if (friend.connectionId === connectionId) match = friend;
    });
    return match;
  }

  private setupEventListeners(): void {
    // Listen for peer discovered - directly check if friend
    this.subscriptions.push(
      Nearby.onPeerDiscovered((peer) => {
        if (!this.isActive) return;
        console.log('[NearbyDiscovery] Peer discovered:', peer.peerName, 'UUID:', peer.peerUUID);

        // Check if this peer is a friend
        if (peer.peerUUID && this.friendUUIDs.includes(peer.peerUUID)) {
          this.cancelGrace(peer.peerUUID);
          const existing = this.discoveredFriends.get(peer.peerUUID);
          const refreshed: DiscoveredFriend = {
            ...(existing ?? { uuid: peer.peerUUID, name: 'Unknown', currentMac: '', addedDate: new Date() }),
            name: peer.peerName || existing?.name || 'Unknown',
            connectionId: peer.connectionId,
            discovered: true,
            lastSeen: new Date(),
          };
          this.discoveredFriends.set(peer.peerUUID, refreshed);
          console.log('[NearbyDiscovery] Friend discovered:', peer.peerUUID);
          this.notifyListeners(refreshed);
        }
      })
    );

    // Listen for connection established
    this.subscriptions.push(
      Nearby.onConnectionEstablished((event) => {
        console.log('[NearbyDiscovery] Connection established:', event.connectionId);
      })
    );

    // Discovery loss clears the endpoint (it must never be dialed again) but
    // keeps the contact for the grace window so presence survives transient
    // signal dips instead of forcing a cold scan on the next dial.
    this.subscriptions.push(
      Nearby.onPeerLost((event) => {
        const friend = this.findByConnection(event.connectionId);
        if (!friend) return;
        const updated: DiscoveredFriend = { ...friend, discovered: false, connectionId: '' };
        this.discoveredFriends.set(friend.uuid, updated);
        console.log('[NearbyDiscovery] Peer lost:', friend.uuid, '· presence kept', PRESENCE_GRACE_MS + 'ms');
        this.notifyListeners(updated);
        this.scheduleGrace(friend.uuid);
      })
    );

    // Listen for connection closed
    this.subscriptions.push(
      Nearby.onConnectionClosed((event) => {
        console.log('[NearbyDiscovery] Connection closed:', event.connectionId);
        const friend = this.findByConnection(event.connectionId);
        if (!friend) return;
        // The endpoint is dead immediately; whether the contact is still
        // visible to the scanner (discovered) does not depend on it.
        const updated: DiscoveredFriend = { ...friend, connectionId: '' };
        this.discoveredFriends.set(friend.uuid, updated);
        this.notifyListeners(updated);
        if (!updated.discovered) this.scheduleGrace(friend.uuid);
      })
    );

    // Listen for discovery errors
    this.subscriptions.push(
      Nearby.onDiscoveryError((event) => {
        console.error('[NearbyDiscovery] Error:', event.error);
      })
    );
  }

  private notifyListeners(friend: DiscoveredFriend): void {
    this.listeners.forEach((listener) => {
      try {
        listener(friend);
      } catch (e) {
        console.error('Listener error:', e);
      }
    });
  }

}

// Singleton instance
export const nearbyDiscoveryService = new NearbyDiscoveryService();
export default nearbyDiscoveryService;
