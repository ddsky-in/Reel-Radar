import { describe, expect, it } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { safeRealtimeSession } from '../src/lib/server/realtime-session';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const owner = 'a0000000-0000-4000-8000-000000000001';
const now = Date.UTC(2026,10,8);
function session(role='authenticated',sub=owner,exp=now/1000+3600): Session {
  return {user:{id:sub},access_token:`header.${Buffer.from(JSON.stringify({role,sub,exp})).toString('base64url')}.signature`,refresh_token:'never-return',expires_at:exp,expires_in:3600,token_type:'bearer'} as Session;
}
describe('realtime auth and sync boundaries',()=>{
  it('returns only verified-owner access token, expiry and owner id',()=>{
    const input=session();
    expect(safeRealtimeSession(input,owner,now)).toEqual({access_token:input.access_token,expires_at:input.expires_at,owner_user_id:owner});
    expect(JSON.stringify(safeRealtimeSession(input,owner,now))).not.toContain('never-return');
  });
  it('refuses expired, wrong-user, privileged and malformed tokens',()=>{
    for(const input of [null,session('service_role'),session('anon'),session('authenticated','other'),session('authenticated',owner,now/1000+5),{...session(),access_token:'invalid'}]) expect(()=>safeRealtimeSession(input,owner,now)).toThrow();
  });
  it('keeps session cookies HttpOnly and bridge same-origin/no-store',()=>{
    const route=readFileSync(join(process.cwd(),'src/app/api/[...path]/route.ts'),'utf8');
    expect(route.indexOf('assertMutationOrigin(request)')).toBeLessThan(route.indexOf("path[1] === 'realtime'"));
    expect(route).toContain('safeRealtimeSession(data.session, user.id)');
    expect(route).toContain('no-store, private');
    expect(readFileSync(join(process.cwd(),'src/lib/supabase/server.ts'),'utf8')).toContain('httpOnly: true');
  });
  it('uses a single signal feed, memory-only auth and no scraper endpoint in sync',()=>{
    const sync=readFileSync(join(process.cwd(),'src/lib/supabase/realtime.ts'),'utf8');
    expect(sync).toContain("table: 'owner_resource_revisions'");
    expect(sync).toContain("event: '*'");
    expect(sync).toContain('persistSession: false');
    expect(sync).toContain('60_000');
    expect(sync).not.toContain('/api/refresh');
    expect(sync).not.toContain('scheduleDispatcherWake');
    expect(sync).not.toContain('localStorage');
  });
  it('removes Notes UI without losing bookmarks, dates, duration or provenance',()=>{
    for(const name of ['reels','explorer','dashboard','competitors']){
      const source=readFileSync(join(process.cwd(),`src/components/${name}.tsx`),'utf8');
      expect(source).not.toContain('ReelNotes');
      expect(source).not.toContain('onEdit=');
    }
    const reels=readFileSync(join(process.cwd(),'src/components/reels.tsx'),'utf8');
    expect(reels).toContain('onSave');
    expect(reels).toContain('published_at_raw');
    expect(readFileSync(join(process.cwd(),'src/components/reel-thumbnail.tsx'),'utf8')).toContain('DurationBadge');
  });
});
