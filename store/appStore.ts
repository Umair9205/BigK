import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface Friend {
  uuid: string; name: string; currentMac: string;
  addedDate: Date; lastSeen?: Date; autoAccept?: boolean;
}
export type CallDirection = 'outgoing' | 'incoming';
export type CallOutcome   = 'completed' | 'missed' | 'rejected' | 'failed';
export interface CallRecord {
  id: string; friendUUID: string; friendName: string;
  direction: CallDirection; outcome: CallOutcome; startedAt: Date; duration: number;
}
export type AudioQuality = 'low' | 'medium' | 'high';
export interface AppSettings {
  audioQuality: AudioQuality; ringtoneEnabled: boolean;
  speakerDefault: boolean; scanningEnabled: boolean;
}

export type CallState = 'idle' | 'discovery' | 'connecting' | 'handshake' | 'acknowledged' | 'streaming' | 'ending' | 'error';
export interface CallSession {
  sessionId: string;
  peerUUID: string;
  peerConnectionId: string;
  startTime: number;
  state: CallState;
  codec: string;
}

export type NearbyDiscoveryState = 'idle' | 'advertising' | 'scanning' | 'active';

const KEYS = {
  friends: '@kela_friends_v2',
  uuid: '@kela_my_uuid',
  name: '@kela_my_name',
  history: '@kela_call_history',
  settings: '@kela_settings',
  callSession: '@kela_call_session',
  lastSeen: '@kela_last_seen',
};

/** Minimum gap between persisted presence timestamps per contact. */
const LAST_SEEN_THROTTLE_MS = 60_000;

const DEFAULT_SETTINGS: AppSettings = { audioQuality:'high', ringtoneEnabled:true, speakerDefault:false, scanningEnabled:true };

interface AppState {
  myUUID: string|null;
  myDeviceName: string|null;
  friends: Friend[];
  callHistory: CallRecord[];
  settings: AppSettings;
  isSetupDone: boolean;

  // Call session persistence
  callSession: CallSession | null;
  saveCallSession: (session: CallSession) => Promise<void>;
  loadCallSession: () => Promise<CallSession | null>;
  clearCallSession: () => Promise<void>;

  // Nearby discovery state
  nearbyState: NearbyDiscoveryState;
  setNearbyState: (state: NearbyDiscoveryState) => void;
  discoveredFriends: Map<string, Friend>;
  updateDiscoveredFriends: (friends: Friend[]) => void;

  // Presence: uuid -> epoch ms of the last discovery sighting. Kept out of
  // `friends` on purpose — every friends write re-configures Nearby availability,
  // which presence updates must not trigger.
  lastSeen: Record<string, number>;
  touchLastSeen: (uuid: string) => void;

  // Existing methods
  initIdentity:(name:string)=>Promise<void>;
  setMyDeviceName:(name:string)=>Promise<void>;
  addFriend:(f:Omit<Friend,'addedDate'>)=>Promise<void>;
  removeFriend:(uuid:string)=>Promise<void>;
  updateFriendMac:(uuid:string,mac:string)=>void;
  setAutoAccept:(uuid:string,val:boolean)=>Promise<void>;
  isFriendByUUID:(uuid:string)=>boolean;
  isFriendByName:(name:string)=>boolean;
  getFriendByUUID:(uuid:string)=>Friend|undefined;
  getCurrentMac:(uuid:string)=>string|null;
  addCallRecord:(r:Omit<CallRecord,'id'>)=>Promise<void>;
  deleteCallRecord:(id:string)=>Promise<void>;
  clearCallHistory:()=>Promise<void>;
  updateSettings:(p:Partial<AppSettings>)=>Promise<void>;
  loadData:()=>Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  myUUID:null,
  myDeviceName:null,
  friends:[],
  callHistory:[],
  settings:DEFAULT_SETTINGS,
  isSetupDone:false,
  callSession: null,
  nearbyState: 'idle',
  discoveredFriends: new Map(),
  lastSeen: {},

  // ============= Call Session Persistence =============
  saveCallSession: async(session)=>{
    try{
      set({callSession:session});
      await AsyncStorage.setItem(KEYS.callSession, JSON.stringify(session));
      console.log('[Store] Call session saved:', session.sessionId);
    }catch(e){console.error('saveCallSession:', e);}
  },

  loadCallSession: async()=>{
    try{
      const data = await AsyncStorage.getItem(KEYS.callSession);
      if(!data) return null;
      const session: CallSession = JSON.parse(data);
      set({callSession:session});
      console.log('[Store] Call session loaded:', session.sessionId);
      return session;
    }catch(e){console.error('loadCallSession:', e); return null;}
  },

  clearCallSession: async()=>{
    try{
      set({callSession:null});
      await AsyncStorage.removeItem(KEYS.callSession);
      console.log('[Store] Call session cleared');
    }catch(e){console.error('clearCallSession:', e);}
  },

  // ============= Nearby Discovery State =============
  setNearbyState: (state)=>{
    set({nearbyState:state});
    console.log('[Store] Nearby state:', state);
  },

  updateDiscoveredFriends: (friends)=>{
    const discovered = new Map<string, Friend>();
    friends.forEach(f => discovered.set(f.uuid, f));
    set({discoveredFriends:discovered});
  },

  // ============= Presence =============
  touchLastSeen: (uuid)=>{
    if (!get().friends.some(f => f.uuid === uuid)) return;
    const now = Date.now();
    if (now - (get().lastSeen[uuid] || 0) < LAST_SEEN_THROTTLE_MS) return;
    const updated = { ...get().lastSeen, [uuid]: now };
    set({ lastSeen: updated });
    void AsyncStorage.setItem(KEYS.lastSeen, JSON.stringify(updated))
      .catch(e => console.warn('touchLastSeen:', e));
  },

  // ============= Existing Methods =============
  initIdentity: async(name)=>{
    try{
      let uuid=await AsyncStorage.getItem(KEYS.uuid);
      if(!uuid){uuid=generateUUID();await AsyncStorage.setItem(KEYS.uuid,uuid);}
      await AsyncStorage.setItem(KEYS.name,name);
      set({myUUID:uuid,myDeviceName:name,isSetupDone:true});
    }catch(e){console.error('initIdentity:',e);throw e;}
  },

  setMyDeviceName: async(name)=>{await AsyncStorage.setItem(KEYS.name,name);set({myDeviceName:name});},

  addFriend: async(friend)=>{
    const ex=get().friends;
    const idx=ex.findIndex(f=>f.uuid===friend.uuid);
    const updated=idx>=0?ex.map((f,i)=>i===idx?{...f,...friend}:f):[...ex,{...friend,addedDate:new Date()}];
    set({friends:updated});
    await AsyncStorage.setItem(KEYS.friends,JSON.stringify(updated));
  },

  removeFriend: async(uuid)=>{
    const f=get().friends.filter(f=>f.uuid!==uuid);
    set({friends:f});
    await AsyncStorage.setItem(KEYS.friends,JSON.stringify(f));
  },

  updateFriendMac: (uuid,mac)=>{
    const f=get().friends.map(f=>f.uuid===uuid?{...f,currentMac:mac,lastSeen:new Date()}:f);
    set({friends:f});
    AsyncStorage.setItem(KEYS.friends,JSON.stringify(f));
  },

  setAutoAccept: async(uuid,val)=>{
    const f=get().friends.map(f=>f.uuid===uuid?{...f,autoAccept:val}:f);
    set({friends:f});
    await AsyncStorage.setItem(KEYS.friends,JSON.stringify(f));
  },

  isFriendByUUID:(uuid)=>get().friends.some(f=>f.uuid===uuid),
  isFriendByName:(name)=>get().friends.some(f=>f.name===name),
  getFriendByUUID:(uuid)=>get().friends.find(f=>f.uuid===uuid),
  getCurrentMac:(uuid)=>get().friends.find(f=>f.uuid===uuid)?.currentMac||null,

  addCallRecord: async(record)=>{
    const history=[{...record,id:generateUUID()},...get().callHistory].slice(0,500);
    set({callHistory:history});
    await AsyncStorage.setItem(KEYS.history,JSON.stringify(history));
  },

  deleteCallRecord: async(id)=>{
    const h=get().callHistory.filter(r=>r.id!==id);
    set({callHistory:h});
    await AsyncStorage.setItem(KEYS.history,JSON.stringify(h));
  },

  clearCallHistory: async()=>{
    set({callHistory:[]});
    await AsyncStorage.removeItem(KEYS.history);
  },

  updateSettings: async(patch)=>{
    const s={...get().settings,...patch};
    set({settings:s});
    await AsyncStorage.setItem(KEYS.settings,JSON.stringify(s));
  },

  loadData: async()=>{
    try{
      const[fr,uuid,name,hr,sr,cs,ls]=await Promise.all([
        AsyncStorage.getItem(KEYS.friends),
        AsyncStorage.getItem(KEYS.uuid),
        AsyncStorage.getItem(KEYS.name),
        AsyncStorage.getItem(KEYS.history),
        AsyncStorage.getItem(KEYS.settings),
        AsyncStorage.getItem(KEYS.callSession),
        AsyncStorage.getItem(KEYS.lastSeen),
      ]);
      const u:any={};
      if(fr)u.friends=JSON.parse(fr).map((f:any)=>({...f,addedDate:new Date(f.addedDate),lastSeen:f.lastSeen?new Date(f.lastSeen):undefined}));
      if(hr)u.callHistory=JSON.parse(hr).map((r:any)=>({...r,startedAt:new Date(r.startedAt)}));
      if(sr)u.settings={...DEFAULT_SETTINGS,...JSON.parse(sr)};
      if(cs)u.callSession=JSON.parse(cs) as CallSession;
      if(ls)u.lastSeen=JSON.parse(ls) as Record<string, number>;
      if(uuid)u.myUUID=uuid;
      if(name){u.myDeviceName=name;u.isSetupDone=true;}
      set(u);
    }catch(e){console.error('loadData:',e);}
  },
}));