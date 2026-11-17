import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel); channel.subscribe.mockReturnValue(channel);
  const realtime = { setAuth: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), connect: vi.fn() };
  return { channel, realtime, createClient: vi.fn(), invalidate: vi.fn(), clear: vi.fn(), epoch: vi.fn().mockReturnValue(0), remove: vi.fn().mockResolvedValue('ok') };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('../src/lib/resource-cache', () => ({ scheduleResourceInvalidation: mocks.invalidate, clearResourceCache: mocks.clear, getResourceCacheEpoch: mocks.epoch }));
import { startAppSync } from '../src/lib/supabase/realtime';
const owner = 'a0000000-0000-4000-8000-000000000001';
let windowTarget: EventTarget, documentTarget: EventTarget & { visibilityState: string }, fetchMock: ReturnType<typeof vi.fn>;
let stop: (() => void) | undefined;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://project.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','sb_publishable_fixture');
  windowTarget = new EventTarget(); documentTarget = Object.assign(new EventTarget(),{visibilityState:'visible'});
  vi.stubGlobal('window',windowTarget); vi.stubGlobal('document',documentTarget);
  fetchMock = vi.fn().mockImplementation(async () => ({ok:true,status:200,json:async()=>({access_token:'memory-only-fixture',owner_user_id:owner,expires_at:Date.now()/1000+3600})}));
  vi.stubGlobal('fetch',fetchMock);
  mocks.createClient.mockReturnValue({realtime:mocks.realtime,channel:vi.fn().mockReturnValue(mocks.channel),removeChannel:mocks.remove});
});
afterEach(() => { stop?.(); stop=undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('app sync connection lifecycle',()=>{
  it('authorizes before subscribing and refreshes once on reconnect and signal',async()=>{
    stop=startAppSync(vi.fn()); await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/realtime',expect.objectContaining({method:'POST',credentials:'same-origin',cache:'no-store'}));
    expect(mocks.realtime.setAuth).toHaveBeenCalledWith('memory-only-fixture');
    expect(mocks.channel.on).toHaveBeenCalledWith('postgres_changes',expect.objectContaining({event:'*',table:'owner_resource_revisions',filter:`owner_user_id=eq.${owner}`}),expect.any(Function));
    const status=mocks.channel.subscribe.mock.calls[0][0]; status('SUBSCRIBED');
    mocks.channel.on.mock.calls[0][2]();
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
  });
  it('uses one disconnected fallback and renews auth without creating another channel',async()=>{
    stop=startAppSync(vi.fn()); await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.channel.subscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('refreshes on focus/online/visible, without refresh-provider requests',async()=>{
    stop=startAppSync(vi.fn()); await settle();
    mocks.channel.subscribe.mock.calls[0][0]('SUBSCRIBED'); mocks.invalidate.mockClear();
    windowTarget.dispatchEvent(new Event('focus')); windowTarget.dispatchEvent(new Event('online'));
    documentTarget.visibilityState='hidden'; documentTarget.dispatchEvent(new Event('visibilitychange'));
    documentTarget.visibilityState='visible'; documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(mocks.invalidate).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(call=>call[0]==='/api/auth/realtime')).toBe(true);
  });
  it('cleans up logout timers, events and pending channel callbacks',async()=>{
    stop=startAppSync(vi.fn()); await settle();
    windowTarget.dispatchEvent(new Event('reelradar-auth-change'));
    windowTarget.dispatchEvent(new Event('focus'));
    mocks.channel.on.mock.calls[0][2]();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.realtime.disconnect).toHaveBeenCalledOnce();
  });
  it('fails closed on unauthorized bridge responses',async()=>{
    fetchMock.mockResolvedValue({ok:false,status:401}); const unauthorized=vi.fn();
    stop=startAppSync(unauthorized); await settle();
    expect(unauthorized).toHaveBeenCalledOnce(); expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.channel.subscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('targets INSERT scopes, keeps normal UPDATEs scoped, and broadens only unknown/gapped signals',async()=>{
    stop=startAppSync(vi.fn()); await settle();
    const receive=mocks.channel.on.mock.calls[0][2];
    const signal=(revision:number,eventType='UPDATE',family='saved_reels')=>({schema:'public',table:'owner_resource_revisions',eventType,new:{owner_user_id:owner,family,workspace_id:null,scope_key:'global',revision,updated_at:'2026-11-15T00:00:00Z'}});
    receive(signal(1,'INSERT'));
    expect(mocks.invalidate).toHaveBeenLastCalledWith(expect.any(Function));
    const matches=mocks.invalidate.mock.calls[0][0];
    expect(matches('/api/workspaces/a/reels')).toBe(true);
    expect(matches('/api/workspaces/a/creators')).toBe(false);
    receive(signal(2)); expect(mocks.invalidate).toHaveBeenCalledTimes(2);
    receive(signal(2)); expect(mocks.invalidate).toHaveBeenCalledTimes(2);
    receive(signal(4)); expect(mocks.invalidate).toHaveBeenLastCalledWith();
    receive(signal(1,'INSERT','unknown')); expect(mocks.invalidate).toHaveBeenLastCalledWith();
    expect(mocks.channel.on.mock.calls.every(call=>call[1].table==='owner_resource_revisions')).toBe(true);
  });
  it('fails closed when renewal discovers a different owner and ignores late signals',async()=>{
    const unauthorized=vi.fn(); stop=startAppSync(unauthorized); await settle();
    mocks.channel.subscribe.mock.calls[0][0]('SUBSCRIBED'); mocks.invalidate.mockClear();
    fetchMock.mockResolvedValue({ok:true,status:200,json:async()=>({access_token:'new-owner',owner_user_id:'a0000000-0000-4000-8000-000000000002',expires_at:Date.now()/1000+3600})});
    await vi.advanceTimersByTimeAsync(600_000);
    expect(unauthorized).toHaveBeenCalledOnce(); expect(mocks.clear).toHaveBeenCalledOnce();
    mocks.channel.on.mock.calls[0][2](); expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it('does not join after auth completes late during logout',async()=>{
    let release!:(value:unknown)=>void;
    mocks.realtime.setAuth.mockReturnValueOnce(new Promise(value=>{release=value;}));
    stop=startAppSync(vi.fn()); await settle();
    windowTarget.dispatchEvent(new Event('reelradar-auth-change')); release(undefined); await settle();
    expect(mocks.channel.subscribe).not.toHaveBeenCalled();
  });
  it('cache epoch clear stops realtime reads even before logout event/remount',async()=>{
    stop=startAppSync(vi.fn()); await settle(); mocks.epoch.mockReturnValueOnce(1);
    mocks.channel.on.mock.calls[0][2]();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mocks.invalidate).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it('falls back broadly when the scoped table is unavailable without joining the legacy feed',async()=>{
    stop=startAppSync(vi.fn()); await settle();
    mocks.channel.subscribe.mock.calls[0][0]('CHANNEL_ERROR');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.invalidate).toHaveBeenCalledWith();
    expect(mocks.channel.on).toHaveBeenCalledTimes(1);
  });
  it('never joins after an unmounted authorization request resolves',async()=>{
    let resolve!: (value: unknown)=>void;
    fetchMock.mockReturnValue(new Promise(value=>{resolve=value;}));
    stop=startAppSync(vi.fn()); stop();
    resolve({ok:true,status:200,json:async()=>({access_token:'late',owner_user_id:owner,expires_at:Date.now()/1000+3600})}); await settle();
    expect(mocks.channel.subscribe).not.toHaveBeenCalled();
  });
});
