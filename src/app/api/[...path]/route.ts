import { syncProviderBilling } from '@/lib/server/billing-sync';
import { parseCollectionHoldsQuery, collectionSettlementSchema, billingSyncSchema } from '@/lib/server/validation';
import { safeCollectionHolds, safeCollectionJobRecovery } from '@/lib/server/public-data';
import { safeProfileAutomation } from '@/lib/server/public-data';
import { parseCreatorQuery } from '@/lib/server/validation';
import { safeCreatorPage, safeCreatorRead, safeCreatorDirectory, safeCollectionSummary, safeCarouselSummaryPage } from '@/lib/server/public-data';
import { after, NextResponse } from 'next/server';
import { authenticatedClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { DemoRepository } from '@/lib/server/demo-repository';
import { SupabaseRepository } from '@/lib/server/supabase-repository';
import type { Repository } from '@/lib/server/repository';
import type { Reel } from '@/lib/types';
import { ApiError, publicError } from '@/lib/server/errors';
import { assertDemoRequest, assertMutationOrigin, consumeLimit, supabaseConfig } from '@/lib/server/security';
import { bookmarkSchema, creatorSchema, idSchema, importSchema, loginSchema, normalizedUsername, parseReelQuery, readJson, reelFilterSchema, refreshSchema, settingsSchema, transcriptionSettingsSchema, validate, workspacePatchSchema, workspaceSchema } from '@/lib/server/validation';
import { resolveReelPeriod } from '@/lib/reel-filters';
import { exportReelsCsv } from '@/lib/server/csv';
import { downloadReel } from '@/lib/server/reel-download';
import { downloadCarousel, parseCarouselDownloadQuery } from '@/lib/server/carousel-download';
import { readCreatorAvatar } from '@/lib/server/creator-avatar';
import { scheduleDispatcherWake } from '@/lib/server/dispatcher';
import { safeRealtimeSession } from '@/lib/server/realtime-session';
import { safeCollectionState, safeApifyAccounts, safeCarouselCollectionStatus } from '@/lib/server/public-data';
import { safeCreatorSourceRefresh } from '@/lib/server/public-data';
import { safeReelNeighbors } from '@/lib/server/public-data';
import { safeCarouselDetail, safeCarouselFilter, safeCarouselPage } from '@/lib/server/carousel-data';
import { carouselFilterSchema, readCarouselQuery } from '@/lib/carousels';
import { carouselBookmarkSchema, carouselRefreshSchema } from '@/lib/server/validation';
import { completionSchema } from '@/lib/server/validation';
import { removeCreatorsSchema } from '@/lib/server/validation';
import { removeCreators } from '@/lib/server/remove-creators';
import { transcriptRequestSchema } from '@/lib/server/validation';
import { safeBootstrap, safeCreator, safeJob, safeOverview, safePage, safeReelDetail, safeReelFilter, safeSettings, safeTranscript, safeTranscriptionOverview, safeUsage, safeWorkspace } from '@/lib/server/public-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
function json(value: unknown, status = 200) { return NextResponse.json(value, { status, headers }); }
function noContent() { return new NextResponse(null, { status: 204, headers }); }

async function dispatch(request: Request, context: Context): Promise<Response> {
  try {
    const { path } = await context.params;
    const demo = assertDemoRequest(request);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation) assertMutationOrigin(request);
    if (path.length === 2 && path[0] === 'auth' && path[1] === 'login' && request.method === 'POST') {
      // A global process cap avoids trusting user-controlled forwarded IP headers.
      consumeLimit('login:global', 40, 15 * 60_000);
      const body = validate(loginSchema, await readJson(request, 4096));
      consumeLimit(`login:${body.email.toLowerCase()}`, 8, 15 * 60_000);
      if (demo) return json({ ok: true, mode: 'demo' });
      const config = supabaseConfig();
      if (body.email.trim().toLowerCase() !== config.ownerEmail) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      const client = await createSupabaseServerClient();
      const { data, error } = await client.auth.signInWithPassword({ email: body.email, password: body.password });
      if (error || !data.user || data.user.id !== config.ownerId || data.user.email?.toLowerCase() !== config.ownerEmail) {
        await client.auth.signOut();
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      }
      return json({ ok: true });
    }
    if (path.length === 2 && path[0] === 'auth' && path[1] === 'realtime' && request.method === 'POST') {
      if (demo) throw new ApiError(503, 'REALTIME_DISABLED', 'Realtime requires an authenticated owner session.');
      const { client, user } = await authenticatedClient();
      consumeLimit(`realtime-token:${user.id}`, 20, 60_000);
      const { data, error } = await client.auth.getSession();
      if (error) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
      return json(safeRealtimeSession(data.session, user.id));
    }
    let repo: Repository;
    let ownerKey = 'demo';
    if (demo) repo = new DemoRepository();
    else {
      const { client, user } = await authenticatedClient();
      ownerKey = user.id;
      repo = new SupabaseRepository(client, user.id, user.email!);
    }
    if (mutation) consumeLimit(`mutation:${ownerKey}`, 80, 60_000);
    if (path.length === 2 && path[0] === 'auth' && path[1] === 'logout' && request.method === 'POST') {
      if (!demo) { const client = await createSupabaseServerClient(); await client.auth.signOut(); }
      return json({ ok: true });
    }
    if (path.length === 1 && path[0] === 'profile-automation' && request.method === 'GET') {
      if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Daily profile refresh status does not accept query parameters.');
      return json(safeProfileAutomation(await repo.profileAutomation()));
    }
    if (path.length === 1 && path[0] === 'apify-accounts' && request.method === 'GET') {
      if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Provider account status does not accept query parameters.');
      return json(safeApifyAccounts(await repo.apifyAccounts()));
    }
    if (path.length === 1 && path[0] === 'bootstrap' && request.method === 'GET') return json(safeBootstrap(await repo.bootstrap()));
    if (path[0] === 'carousel-filters' && (path.length === 1 || path.length === 2)) {
      if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Saved carousel filters do not accept query parameters.');
      if (path.length === 1 && request.method === 'GET') return json((await repo.carouselFilters()).map(safeCarouselFilter));
      if (path.length === 1 && request.method === 'POST') {
        const body = validate(carouselFilterSchema, await readJson(request));
        return json(safeCarouselFilter(await repo.createCarouselFilter(body.name, body.query)), 201);
      }
      if (path.length === 2 && request.method === 'DELETE') {
        await repo.deleteCarouselFilter(validate(idSchema, path[1]));
        return noContent();
      }
    }
    if (path.length === 2 && path[0] === 'billing' && path[1] === 'sync' && request.method === 'POST') {
      if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Billing sync does not accept query parameters.');
      validate(billingSyncSchema, await readJson(request, 256));
      consumeLimit(`billing-sync:${ownerKey}`, 3, 60_000);
      if (demo) throw new ApiError(409, 'DEMO_ONLY', 'Synthetic demo billing cannot be synced. No external provider was called.');
      return json(await syncProviderBilling());
    }
    if (path.length === 2 && path[0] === 'jobs' && path[1] === 'holds' && request.method === 'GET') {
      const query = parseCollectionHoldsQuery(new URL(request.url).searchParams);
      return json(safeCollectionHolds(await repo.collectionHolds(query.page, query.limit)));
    }
    if (path.length === 3 && path[0] === 'jobs' && ['recovery', 'settlement'].includes(path[2])) {
      if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Job recovery actions do not accept query parameters.');
      const id = validate(idSchema, path[1]);
      if (path[2] === 'recovery' && request.method === 'GET') return json(safeCollectionJobRecovery(await repo.collectionJobRecovery(id)));
      if (path[2] === 'settlement' && request.method === 'POST') {
        consumeLimit(`settlement:${ownerKey}`, 10, 60_000);
        const body = validate(collectionSettlementSchema, await readJson(request, 8192));
        return json(safeCollectionJobRecovery(await repo.settleCollectionJob(id, body)));
      }
    }
    if (path.length === 1 && path[0] === 'jobs' && request.method === 'GET') {
      const data = await repo.jobs();
      return json({ jobs: data.jobs.map(safeJob), usage: safeUsage(data.usage) });
    }
    if (path.length === 1 && path[0] === 'reel-filters' && request.method === 'GET') {
      if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Saved reel filters do not accept query parameters.');
      return json((await repo.reelFilters()).map(safeReelFilter));
    }
    if (path.length === 1 && path[0] === 'reel-filters' && request.method === 'POST') {
      if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Saved reel filters do not accept query parameters.');
      const body = validate(reelFilterSchema, await readJson(request));
      return json(safeReelFilter(await repo.createReelFilter(body.name, body.query)), 201);
    }
    if (path.length === 2 && path[0] === 'reel-filters' && request.method === 'DELETE') {
      if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Saved reel filters do not accept query parameters.');
      await repo.deleteReelFilter(validate(idSchema, path[1]));
      return noContent();
    }
    if (path.length === 1 && path[0] === 'transcription' && request.method === 'GET') return json(safeTranscriptionOverview(await repo.transcription()));
    if (path.length === 1 && path[0] === 'transcription' && request.method === 'PATCH') {
      const body = validate(transcriptionSettingsSchema, await readJson(request, 4096));
      return json(safeTranscriptionOverview(await repo.transcriptionSettings(body)));
    }
    if (path.length === 1 && path[0] === 'settings' && request.method === 'PATCH') {
      const input = await readJson(request);
      if (input && typeof input === 'object' && 'scraping_enabled' in input) throw new ApiError(403, 'SCRAPING_SETUP_REQUIRED', 'Scraping enablement requires validated server-side setup and cannot be changed from the browser.');
      if (input && typeof input === 'object' && ('initial_backfill_enabled' in input || 'initial_backfill_limit' in input)) throw new ApiError(403, 'INITIAL_BACKFILL_READ_ONLY', 'Initial import setup is server-managed and its limit is fixed at 100.');
      const patch = validate(settingsSchema, input);
      const saved = safeSettings(await repo.settings(patch));
      // Saving safety limits never dispatches queued paid work.
      return json(saved);
    }
    if (path.length === 1 && path[0] === 'refresh' && request.method === 'POST') {
      consumeLimit(`refresh:${ownerKey}`, 5, 60_000);
      const body = validate(refreshSchema, await readJson(request));
      const result = await repo.refresh(body.workspace_id, body.creator_ids);
      if (demo) return json(result, 202);
      const { wake_dispatcher, ...publicResult } = result;
      const processing = wake_dispatcher === false ? result.processing : scheduleDispatcherWake(after);
      return json({ ...publicResult, processing, message: processing === 'configuration_required' ? 'Refresh queued. Processing configuration is required; the durable job has been preserved.' : result.message }, 202);
    }
    if (path.length === 1 && path[0] === 'workspaces' && request.method === 'POST') {
      const body = validate(workspaceSchema, await readJson(request));
      return json(safeWorkspace(await repo.createWorkspace(body.name)), 201);
    }
    if (path[0] === 'workspaces' && path.length >= 2) {
      const id = validate(idSchema, path[1]);
      if (path.length === 3 && path[2] === 'competitors' && request.method === 'GET') {
        return json(safeCreatorPage(await repo.queryCreators(id, parseCreatorQuery(new URL(request.url).searchParams))));
      }
      if (path.length === 3 && ['creator-directory', 'collection-summary'].includes(path[2]) && request.method === 'GET') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'This research read does not accept query parameters.');
        return path[2] === 'creator-directory' ? json(safeCreatorDirectory(await repo.creatorDirectory(id))) : json(safeCollectionSummary(await repo.collectionSummary(id)));
      }
      if (path.length === 3 && path[2] === 'carousel-summaries' && request.method === 'GET') {
        let query;
        try { query = readCarouselQuery(new URL(request.url).searchParams); } catch { throw new ApiError(400, 'INVALID_QUERY', 'Please check the carousel filters.'); }
        return json(safeCarouselSummaryPage(await repo.carouselSummaries(id, query)));
      }
      if (path[2]==='carousels') {
        const params=new URL(request.url).searchParams;
        if (path.length===3 && request.method==='GET') {
          let query;
          try { query=readCarouselQuery(params); } catch { throw new ApiError(400,'INVALID_QUERY','Please check the carousel filters.'); }
          return json(safeCarouselPage(await repo.carousels(id,query)));
        }
        if (path.length===5 && path[4]==='download' && request.method==='GET') {
          parseCarouselDownloadQuery(params);
          consumeLimit(`carousel-download:${ownerKey}`,10,60_000);
          return await downloadCarousel(repo,id,validate(idSchema,path[3]),params,request.signal);
        }
        if (params.size) throw new ApiError(400,'INVALID_QUERY','This carousel action does not accept query parameters.');
        if (path.length===4 && path[3]==='collection-status' && request.method==='GET') return json(safeCarouselCollectionStatus(await repo.carouselCollectionStatus(id)));
        if (path.length===4 && path[3]==='refresh' && request.method==='POST') {
          consumeLimit('carousel-refresh:'+ownerKey,5,60_000);
          const raw=await readJson(request,8192);
          if (raw && typeof raw==='object' && 'creator_ids' in raw && Array.isArray(raw.creator_ids) && raw.creator_ids.length>120) {
            throw new ApiError(409,'CAROUSEL_SELECTION_REQUIRED','Choose up to 120 channels in the Channels filter before collecting. No collection was requested.');
          }
          const input=validate(carouselRefreshSchema,raw);
          const result=await repo.refreshCarousels(id,input.creator_ids);
          const {wake_dispatcher,...publicResult}=result;
          const processing=demo ? 'configuration_required' : wake_dispatcher===false || result.processing==='blocked' || result.processing==='in_progress' || result.processing==='configuration_required' ? result.processing : scheduleDispatcherWake(after);
          return json({...publicResult,processing,message:processing==='configuration_required' ? 'Carousel jobs preserved. Processing configuration is required; no new posts have been fetched by this request. Reload library reads stored data only.' : result.message},202);
        }
        if (path.length===4 && request.method==='GET') return json(safeCarouselDetail(await repo.carouselDetail(id,validate(idSchema,path[3]))));
        if (path.length===5 && path[4]==='saved' && request.method==='PUT') {
          const input=validate(carouselBookmarkSchema,await readJson(request,8192));
          await repo.saveCarousel(id,validate(idSchema,path[3]),input.saved,input.note,input.tags);
          return noContent();
        }
      }
      if (path.length === 2 && request.method === 'PATCH') return json(safeWorkspace(await repo.updateWorkspace(id, validate(workspacePatchSchema, await readJson(request)))));
      if (path.length === 3 && path[2] === 'overview' && request.method === 'GET') return json(safeOverview(await repo.overview(id)));
      if (path.length === 3 && path[2] === 'collection-status' && request.method === 'GET') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Collection status does not accept query parameters.');
        return json(safeCollectionState(await repo.collectionState(id)));
      }
      if (path.length === 3 && path[2] === 'creators' && request.method === 'GET') return json((await repo.creators(id)).map(safeCreator));
      if (path.length === 3 && path[2] === 'creators' && request.method === 'DELETE') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Bulk deletion does not accept query parameters.');
        consumeLimit(`bulk-remove:${ownerKey}`, 10, 60_000);
        const body = validate(removeCreatorsSchema, await readJson(request, 45_000));
        return json(await removeCreators(repo, id, body.creator_ids));
      }
      if (path.length === 3 && path[2] === 'creators' && request.method === 'POST') {
        const body = validate(creatorSchema, await readJson(request));
        const creator = safeCreator(await repo.addCreator(id, normalizedUsername(body.username)));
        if (demo) return json({ ...creator, message: 'Profile added to the local demo. No real data was fetched.' }, 201);
        if (!creator.initial_backfill_job_id && !creator.profile_job_ids?.length) return json({ ...creator, message: creator.initial_backfill_status === 'not_queued' || creator.initial_backfill_status === 'disabled' || creator.initial_backfill_status === 'blocked' ? 'Profile added. Initial import requires server-side setup; no initial job was queued.' : 'Profile linked to your workspace. Existing shared data is reused; no new initial import was queued.' }, 201);
        const processing = scheduleDispatcherWake(after);
        const message = ['Profile added.', creator.initial_backfill_job_id ? 'Initial import queued: up to 100 recent available Reels.' : '', creator.profile_job_ids?.length ? 'Profile photo, name and follower count queued.' : '', processing === 'configuration_required' ? 'Processing configuration is required.' : ''].filter(Boolean).join(' ');
        return json({ ...creator, processing, message }, 201);
      }
      if (path.length === 4 && path[2] === 'creators' && path[3] === 'import' && request.method === 'POST') {
        consumeLimit(`import:${ownerKey}`, 10, 60_000);
        const body = validate(importSchema, await readJson(request, 1_100_000));
        const result = await repo.importCreators(id, body.csv, body.preview);
        if (!demo && !body.preview && result.job_ids?.length) {
          const processing = scheduleDispatcherWake(after);
          const reelJobs = result.job_ids.length - (result.profile_job_ids?.length ?? 0);
          const message = [reelJobs > 0 ? 'Initial imports queued: up to 100 recent available Reels per new profile.' : '', result.profile_job_ids?.length ? 'Profile photos, names and follower counts queued.' : '', 'Shared profiles reuse existing data.', processing === 'configuration_required' ? 'Processing configuration is required.' : ''].filter(Boolean).join(' ');
          return json({ ...result, processing, message });
        }
        return json(result);
      }
      if (path.length === 5 && path[2] === 'creators' && path[4] === 'avatar' && request.method === 'GET') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Profile photos do not accept query parameters.');
        const creatorId = validate(idSchema, path[3]);
        consumeLimit(`creator-avatar:${ownerKey}`, 240, 60_000);
        return await readCreatorAvatar(repo, id, creatorId, ownerKey, request.signal, { demoMode: demo });
      }
      if (path.length === 4 && path[2] === 'creators' && request.method === 'GET') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Competitor details do not accept query parameters.');
        return json(safeCreatorRead(await repo.creator(id, validate(idSchema, path[3]))));
      }
      if (path.length === 4 && path[2] === 'creators' && request.method === 'DELETE') { await repo.removeCreator(id, validate(idSchema, path[3])); return noContent(); }
      if (path.length === 5 && path[2] === 'creators' && path[4] === 'source-refresh') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Source refresh does not accept query parameters.');
        const creatorId = validate(idSchema, path[3]);
        if (request.method === 'GET') return json(safeCreatorSourceRefresh(await repo.creatorSourceRefresh(id, creatorId)));
        if (request.method === 'POST') {
          consumeLimit(`source-refresh:${ownerKey}`, 5, 60_000);
          const body = await readJson(request, 256);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ApiError(400, 'INVALID_INPUT', 'Source refresh requires an empty object.');
          const result = await repo.requestCreatorSourceRefresh(id, creatorId);
          const processing = demo ? 'configuration_required' : scheduleDispatcherWake(after);
          return json({ ...result, processing }, 202);
        }
      }
      if (path.length === 3 && path[2] === 'reels' && request.method === 'GET') return json(safePage(await repo.reels(id, parseReelQuery(new URL(request.url).searchParams))));
      if (path.length === 4 && path[2] === 'reels' && request.method === 'GET') {
        return json(safeReelDetail(await repo.reelDetail(id, validate(idSchema, path[3]))));
      }
      if (path.length === 5 && path[2] === 'reels' && path[4] === 'neighbors' && request.method === 'GET') {
        return json(safeReelNeighbors(await repo.reelNeighbors(id, validate(idSchema, path[3]), parseReelQuery(new URL(request.url).searchParams))));
      }
      if (path.length === 5 && path[2] === 'reels' && path[4] === 'download' && request.method === 'GET') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Video downloads do not accept query parameters.');
        consumeLimit(`reel-download:${ownerKey}`, 10, 60_000);
        return await downloadReel(repo, id, validate(idSchema, path[3]), request.signal);
      }
      if (path.length === 5 && path[2] === 'reels' && path[4] === 'transcript' && request.method === 'POST') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Transcript requests do not accept query parameters.');
        consumeLimit(`reel-transcript:${ownerKey}`, 20, 60_000);
        const body = validate(transcriptRequestSchema, await readJson(request, 256));
        return json(safeReelDetail(await repo.requestTranscript(id, validate(idSchema, path[3]), body)));
      }
      if (path.length === 5 && path[2] === 'reels' && path[4] === 'transcript' && request.method === 'GET') {
        return json(safeTranscript(await repo.transcript(id, validate(idSchema, path[3]))));
      }
      if (path.length === 3 && path[2] === 'export' && request.method === 'GET') {
        consumeLimit(`export:${ownerKey}`, 5, 60_000);
        // Resolve the IST rolling window once so every export page uses the same dates.
        const query = resolveReelPeriod(parseReelQuery(new URL(request.url).searchParams));
        const all: Reel[] = [];
        for (let page = 1; page <= 200; page++) {
          const result = await repo.reels(id, { ...query, page, limit: 50 });
          if (result.total > 10_000) throw new ApiError(422, 'EXPORT_TOO_LARGE', 'More than 10000 Reels match. Narrow the filters before exporting.');
          all.push(...result.items);
          if (all.length > 10_000) throw new ApiError(422, 'EXPORT_TOO_LARGE', 'The export limit is 10000 Reels.');
          if (result.items.length < 50 || all.length >= result.total) break;
        }
        return new NextResponse(exportReelsCsv(all), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="reelradar-reels.csv"' } });
      }
      if (path.length === 3 && path[2] === 'saved' && request.method === 'POST') {
        const body = validate(bookmarkSchema, await readJson(request));
        await repo.save(id, body.reel_id, body.note ?? '', body.tags ?? []);
        return json({ ok: true });
      }
      if (path.length === 4 && path[2] === 'saved' && request.method === 'DELETE') { await repo.unsave(id, validate(idSchema, path[3])); return noContent(); }
      if (path.length === 4 && path[2] === 'saved' && request.method === 'PATCH') {
        if (new URL(request.url).search) throw new ApiError(400, 'INVALID_QUERY', 'Completion updates do not accept query parameters.');
        const body = validate(completionSchema, await readJson(request, 256));
        await repo.setCompletion(id, validate(idSchema, path[3]), body.completion_status);
        return noContent();
      }
    }
    throw new ApiError(404, 'NOT_FOUND', 'API route not found.');
  } catch (error) {
    const response = publicError(error);
    return json(response.body, response.status);
  }
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
