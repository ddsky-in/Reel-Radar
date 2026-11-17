import type { CollectionHolds, CollectionJobRecovery, CollectionSettlementRequest } from '../types';
import { settingsSchema, collectionHoldsQuerySchema, collectionSettlementSchema } from './validation';
import { safeCollectionHolds, safeCollectionJobRecovery } from './public-data';
import type { CreatorQuery, CreatorDirectoryEntry, CreatorCollectionSummary, CarouselSummary } from '../types';
import { creatorQuerySchema } from './validation';
import { safeCreatorPage, safeCreatorRead, safeCreatorDirectory, safeCollectionSummary, safeCarouselSummaryPage } from './public-data';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Carousel, CarouselDetail, CarouselQuery, SavedCarouselFilter } from '../types';
import { carouselFilterSchema, carouselQuerySchema } from '../carousels';
import type { AppSettings, Bootstrap, Creator, Overview, PageResult, Reel, ReelDetail, ReelQuery, SavedReelFilter, ReelTranscript, TranscriptOverview, TranscriptionSettingsPatch, Workspace } from '../types';
import { resolveReelPeriod } from '../reel-filters';
import { idSchema, reelFilterSchema, transcriptionSettingsSchema, validate } from './validation';
import { transcriptRequestSchema } from './validation';
import type { TranscriptRequest } from '../types';
import type { ReelCompletionStatus, ReelNeighbors } from '../types';
import type { ImportResult, Repository } from './repository';
import { ApiError } from './errors';
import type { CreatorSourceRefresh } from '../types';
import { parseCreatorCsv, previewCsv } from './csv';

import type { CreatorCollectionState } from '../types';
import { safeProfileAutomation, safeCollectionState, safeApifyAccounts, safeCarouselCollectionStatus } from './public-data';
import { collectionMessage } from '../collection-status';

export class SupabaseRepository implements Repository {
  async carouselSummaries(id: string, query: CarouselQuery): Promise<PageResult<CarouselSummary>> {
    await this.workspace(id);
    return safeCarouselSummaryPage(await this.rpc('query_carousel_summaries', { p_workspace_id: id, p_query: validate(carouselQuerySchema, query) }, async () => {
      const result = await this.carousels(id, query);
      return { ...result, items: result.items.map(post => ({ ...post, caption_preview: post.caption.slice(0, 500), slide_count: post.slides.length, thumbnail_url: post.thumbnail_url ?? post.slides[0]?.image_url ?? null })) };
    }));
  }
  async carousels(id: string, query: CarouselQuery): Promise<PageResult<Carousel>> {
    await this.workspace(id); return this.rpc('query_carousels',{ p_workspace_id:id,p_query:validate(carouselQuerySchema,query) });
  }
  async carouselDetail(id: string, carouselId: string): Promise<CarouselDetail> {
    await this.workspace(id); return this.rpc('get_carousel_detail',{ p_workspace_id:id,p_carousel_id:validate(idSchema,carouselId) });
  }
  async saveCarousel(id: string, carouselId: string, saved: boolean, note='', tags: string[]=[]): Promise<void> {
    await this.mutableWorkspace(id);
    await this.rpc('set_carousel_bookmark',{ p_workspace_id:id,p_carousel_id:validate(idSchema,carouselId),p_saved:saved,p_note:note,p_tags:tags });
  }
  async carouselCollectionStatus(id: string) {
    await this.workspace(id);
    return safeCarouselCollectionStatus(await this.rpc('get_carousel_collection_status', { p_workspace_id: id }));
  }
  async refreshCarousels(id: string, creatorIds?: string[]): Promise<import('./repository').RefreshResult> {
    await this.mutableWorkspace(id);
    if (creatorIds !== undefined && (!Array.isArray(creatorIds) || creatorIds.length === 0)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Choose at least one channel to collect carousels.');
    }
    if (creatorIds && creatorIds.length > 120) {
      throw new ApiError(409, 'CAROUSEL_SELECTION_REQUIRED', 'Choose up to 120 channels in the Channels filter before collecting. No collection was requested.');
    }
    const selected = creatorIds?.map(creatorId => validate(idSchema, creatorId));
    // Resolve ALL to an explicit owner-authorized scope. Legacy NULL silently takes
    // the first 120 repeatedly; never slice or issue browser-side paid batches.
    const directory = await this.creatorDirectory(id);
    if (!selected && directory.length > 120) {
      throw new ApiError(409, 'CAROUSEL_SELECTION_REQUIRED', `This workspace has ${directory.length} channels. Choose up to 120 in the Channels filter before collecting. No collection was requested.`);
    }
    if (selected?.some(creatorId => !directory.some(creator => creator.id === creatorId))) {
      throw new ApiError(403, 'FORBIDDEN', 'A selected channel is not available in this workspace.');
    }
    const requested = selected ?? directory.map(creator => creator.id);
    if (!requested.length) throw new ApiError(409, 'NO_JOB_ENQUEUED', 'No channels are available in this workspace. No collection was requested.');
    const status = await this.carouselCollectionStatus(id);
    // The legacy status cannot identify manual vs automatic canonical pending jobs.
    // Do not turn disabled automatic work into a claim or request duplicate paid work.
    if (status.reason && (status.pending_jobs > 0 || status.active_jobs > 0)) {
      throw new ApiError(409, 'CAROUSEL_COLLECTION_BLOCKED', 'Existing carousel work is blocked or cannot be confirmed while collection is disabled, paused, or awaiting setup. Check Jobs and collection setup; no duplicate collection was requested.');
    }
    const result = await this.rpc<{job_ids:string[]}>('enqueue_carousel_refresh', {p_workspace_id:id, p_creator_ids:requested});
    if (!result.job_ids?.length) throw new ApiError(409,'NO_JOB_ENQUEUED','No eligible competitors. Check collection setup and Jobs.');
    const jobIds = result.job_ids.map(jobId => validate(idSchema, jobId));
    return { job_id:jobIds[0], job_ids:jobIds, processing:'queued', wake_dispatcher:true,
      carousel_collection: { scope:selected ? 'selected' : 'workspace', requested_creators:requested.length, selection_limit:120,
        new_jobs:null, reused_jobs:null, status_before_request:status },
      message:'Carousel collection jobs queued or reused. The server does not distinguish new and existing jobs. No new posts have been fetched by this request; reload the library to read stored data.' };
  }
  constructor(private client: SupabaseClient, private userId: string, private email: string) {}
  private async rpc<T>(name: string, args?: Record<string, unknown>, missingRead?: () => Promise<T>): Promise<T> {
    const { data, error } = await this.client.rpc(name, args);
    if (error) {
      // Rolling read upgrades may use the existing owner-authorized RPC only
      // when PostgREST proves the new function is absent. Never bypass a denial.
      if (error.code === 'PGRST202' && missingRead) return missingRead();
      // Only known constraint/auth codes become public errors. Never expose SQL detail/hint/message.
      console.error('[ReelRadar] database request failed', { rpc: name, code: error.code });
      if (['create_reel_filter', 'create_carousel_filter'].includes(name) && error.code === '23505') throw new ApiError(409, 'DUPLICATE_FILTER', 'A saved filter with this name already exists.');
      if (name === 'create_carousel_filter' && error.code === '22023' && error.message === 'carousel_filter_limit_reached') throw new ApiError(409, 'CAROUSEL_FILTER_LIMIT', 'You can save at most 50 carousel filters. Delete one before saving another.');
      if (name === 'delete_carousel_filter' && error.code === '42501' && error.message === 'carousel_filter_not_found') throw new ApiError(404, 'NOT_FOUND', 'Saved carousel filter not found.');
      if (name === 'create_reel_filter' && error.code === '22023' && error.message === 'reel_filter_limit_reached') throw new ApiError(409, 'REEL_FILTER_LIMIT', 'You can save at most 50 reel filters. Delete one before saving another.');
      if (name === 'delete_reel_filter' && error.code === '42501' && error.message === 'reel_filter_not_found') throw new ApiError(404, 'NOT_FOUND', 'Saved reel filter not found.');
      if (name === 'collection_settle_job' && error.code === '40001') throw new ApiError(409, 'SETTLEMENT_STATE_CHANGED', 'This hold changed. Read its recovery details again before making a new decision.');
      if (name === 'collection_settle_job' && ['22023', 'P0001', '23514'].includes(error.code)) throw new ApiError(409, 'SETTLEMENT_REJECTED', 'This hold cannot be released in its current state. The administrator-controlled paid-start gate must be enabled; refresh recovery details before another decision.');
      if (error.code === '42501') throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this resource.');
      if (name === 'retry_reel_transcript' && error.code === '40001') throw new ApiError(409, 'RETRY_STATE_CHANGED', 'Transcript status changed. Refresh this Reel before retrying.');
      if (error.code === '23505') throw new ApiError(409, 'DUPLICATE', 'This record already exists.');
      if (error.code === 'P0002') throw new ApiError(404, 'NOT_FOUND', 'The requested record was not found.');
      if (['23514', '22023', 'P0001'].includes(error.code)) throw new ApiError(409, 'CONSTRAINT_REJECTED', 'The action was rejected by capacity, budget, setup, or validation safeguards.');
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'The data service is unavailable. Please try again later.');
    }
    return data as T;
  }
  async workspace(id: string): Promise<Workspace> {
    const { data: membership, error: membershipError } = await this.client.from('workspace_members').select('workspace_id').eq('workspace_id', id).eq('user_id', this.userId).maybeSingle();
    if (membershipError) {
      console.error('[ReelRadar] membership check failed', { code: membershipError.code });
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Workspace authorization could not be checked.');
    }
    if (!membership) throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
    const { data, error } = await this.client.from('workspaces').select('id,name,slug,created_at,archived_at').eq('id', id).maybeSingle();
    if (error) {
      console.error('[ReelRadar] workspace read failed', { code: error.code });
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Workspace data could not be loaded.');
    }
    if (!data) throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
    return data as Workspace;
  }
  private async mutableWorkspace(id: string) {
    const workspace = await this.workspace(id);
    if (workspace.archived_at) throw new ApiError(409, 'WORKSPACE_ARCHIVED', 'Restore the workspace before making changes.');
    return workspace;
  }
  async bootstrap(): Promise<Bootstrap> {
    const data = await this.rpc<Bootstrap>('get_bootstrap');
    return { mode: 'supabase', email: this.email, workspaces: data.workspaces, settings: data.settings, jobs: data.jobs, usage: data.usage, ...(data.collection_capacity !== undefined ? { collection_capacity: data.collection_capacity } : {}) };
  }
  async profileAutomation() { return safeProfileAutomation(await this.rpc('get_profile_automation_status')); }
  async apifyAccounts() { return safeApifyAccounts(await this.rpc('get_apify_account_status')); }
  async overview(id: string): Promise<Overview> { await this.workspace(id); return this.rpc('get_overview', { p_workspace_id: id }); }
  async creators(id: string): Promise<Creator[]> { await this.workspace(id); return this.rpc('list_creators', { p_workspace_id: id }); }
  async queryCreators(id: string, query: CreatorQuery): Promise<PageResult<Creator>> {
    await this.workspace(id);
    const input = validate(creatorQuerySchema, query);
    return safeCreatorPage(await this.rpc('query_creators', { p_workspace_id: id, p_query: input }, async () => {
      const search = input.search?.toLowerCase() ?? '', page = input.page ?? 1, limit = input.limit ?? 50;
      const rows = (await this.creators(id)).filter(creator => `${creator.username} ${creator.display_name ?? ''}`.toLowerCase().includes(search));
      rows.sort((a, b) => a.username < b.username ? -1 : a.username > b.username ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return { items: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit };
    }));
  }
  async creatorDirectory(id: string): Promise<CreatorDirectoryEntry[]> {
    await this.workspace(id);
    return safeCreatorDirectory(await this.rpc('list_creator_directory', { p_workspace_id: id }, () => this.creators(id)));
  }
  async creator(id: string, creatorId: string): Promise<Creator> {
    await this.workspace(id);
    const selectedId = validate(idSchema, creatorId);
    return safeCreatorRead(await this.rpc('get_creator', { p_workspace_id: id, p_creator_id: selectedId }, async () => {
      const creator = (await this.creators(id)).find(row => row.id === selectedId);
      if (!creator) throw new ApiError(404, 'NOT_FOUND', 'The requested record was not found.');
      return creator;
    }));
  }
  async collectionSummary(id: string): Promise<CreatorCollectionSummary> {
    await this.workspace(id);
    return safeCollectionSummary(await this.rpc('get_creator_collection_summary', { p_workspace_id: id }, async () => {
      const state = await this.collectionState(id);
      return { reason: state.reason, blocking_job_id: state.blocking_job_id, pending_jobs: state.pending_job_ids.length, active_jobs: state.active_job_ids.length };
    }));
  }
  async collectionState(id: string, creatorIds?: string[]): Promise<CreatorCollectionState> {
    await this.workspace(id);
    return safeCollectionState(await this.rpc('get_creator_collection_state', { p_workspace_id: id, p_creator_ids: creatorIds ? [...new Set(creatorIds)] : null }));
  }
  async addCreator(id: string, username: string): Promise<Creator> { await this.mutableWorkspace(id); return this.rpc('add_creator', { p_workspace_id: id, p_username: username }); }
  async removeCreator(id: string, creatorId: string): Promise<void> { await this.mutableWorkspace(id); await this.rpc('remove_creator', { p_workspace_id: id, p_creator_id: creatorId }); }
  async importCreators(id: string, csv: string, preview: boolean): Promise<ImportResult> {
    const workspace = await this.mutableWorkspace(id);
    const parsed = parseCreatorCsv(csv, workspace.name);
    const { workspaces } = await this.bootstrap();
    const destinations = new Set(parsed.filter(row => row.username).map(row => row.workspace.toLowerCase()));
    const existing = new Map<string, Set<string>>();
    for (const target of workspaces.filter(target => destinations.has(target.name.toLowerCase()))) {
      if (target.archived_at && !preview) throw new ApiError(409, 'WORKSPACE_ARCHIVED', 'A destination workspace is archived.');
      const creators = await this.creators(target.id);
      existing.set(target.name.toLowerCase(), new Set(creators.map(creator => creator.username)));
    }
    const rows = previewCsv(parsed, existing);
    const result: ImportResult = { rows, added: 0, duplicates: rows.filter(row => row.status === 'duplicate').length, invalid: rows.filter(row => row.status === 'invalid').length };
    if (!preview && rows.some(row => row.status === 'ready')) {
      // The RPC locks capacity and performs all links/new workspaces atomically, handling races.
      const committed = await this.rpc<{ added: number; duplicates: number; workspaces_created: number; job_ids?: string[]; profile_job_ids?: string[] }>('import_creators', { p_workspace_id: id, p_rows: rows.filter(row => row.status !== 'invalid').map(row => ({ username: row.username, workspace: row.workspace })) });
      result.added = committed.added;
      result.duplicates = committed.duplicates;
      if (committed.job_ids) result.job_ids = committed.job_ids;
      if (committed.profile_job_ids) result.profile_job_ids = committed.profile_job_ids;
    }
    return result;
  }
  async createWorkspace(name: string): Promise<Workspace> { return this.rpc('create_workspace', { p_name: name }); }
  async updateWorkspace(id: string, patch: { name?: string; archived?: boolean }): Promise<Workspace> { await this.workspace(id); return this.rpc('update_workspace', { p_workspace_id: id, p_name: patch.name ?? null, p_archived: patch.archived ?? null }); }
  async reels(id: string, query: ReelQuery): Promise<PageResult<Reel>> { await this.workspace(id); return this.rpc('query_reels', { p_workspace_id: id, p_query: resolveReelPeriod(query) }); }
  async reelDetail(id: string, reelId: string): Promise<ReelDetail> {
    await this.workspace(id);
    return this.rpc('get_reel_detail', { p_workspace_id: id, p_reel_id: validate(idSchema, reelId) });
  }
  async requestTranscript(id: string, reelId: string, input: TranscriptRequest = {}): Promise<ReelDetail> {
    await this.mutableWorkspace(id);
    const body = validate(transcriptRequestSchema, input);
    if ('retry_attempt_id' in body) return this.rpc('retry_reel_transcript', {
      p_workspace_id: id, p_reel_id: validate(idSchema, reelId),
      p_attempt_id: body.retry_attempt_id, p_accept_duplicate_charge: body.accept_duplicate_charge,
    });
    // SQL rechecks owner + active workspace association; the existing worker owns paid reservations.
    return this.rpc('request_reel_transcript', { p_workspace_id: id, p_reel_id: validate(idSchema, reelId) });
  }
  async reelNeighbors(id: string, reelId: string, query: ReelQuery): Promise<ReelNeighbors> {
    await this.workspace(id);
    return this.rpc('get_reel_neighbors', { p_workspace_id: id, p_reel_id: validate(idSchema, reelId), p_query: resolveReelPeriod(query) });
  }
  async setCompletion(id: string, reelId: string, status: ReelCompletionStatus): Promise<void> {
    await this.mutableWorkspace(id);
    if (!['pending', 'done'].includes(status)) throw new ApiError(400, 'INVALID_INPUT', 'Choose Pending or Done.');
    await this.rpc('set_saved_reel_completion', { p_workspace_id: id, p_reel_id: validate(idSchema, reelId), p_status: status });
  }
  async reelFilters(): Promise<SavedReelFilter[]> { return this.rpc('list_reel_filters'); }
  async carouselFilters(): Promise<SavedCarouselFilter[]> { return this.rpc('list_carousel_filters'); }
  async createCarouselFilter(name: string, query: CarouselQuery): Promise<SavedCarouselFilter> {
    const body = validate(carouselFilterSchema, { name, query });
    return this.rpc('create_carousel_filter', { p_name: body.name, p_query: body.query });
  }
  async deleteCarouselFilter(id: string): Promise<void> { await this.rpc('delete_carousel_filter', { p_filter_id: validate(idSchema, id) }); }
  async createReelFilter(name: string, query: ReelQuery): Promise<SavedReelFilter> {
    const body = validate(reelFilterSchema, { name, query });
    // Store the rolling descriptor, not today's resolved dates. SQL enforces owner and the atomic 50-preset cap.
    return this.rpc('create_reel_filter', { p_name: body.name, p_query: body.query });
  }
  async deleteReelFilter(id: string): Promise<void> { await this.rpc('delete_reel_filter', { p_filter_id: validate(idSchema, id) }); }
  async save(id: string, reelId: string, note: string, tags: string[]): Promise<void> { await this.mutableWorkspace(id); await this.rpc('set_bookmark', { p_workspace_id: id, p_reel_id: reelId, p_saved: true, p_note: note, p_tags: [...new Set(tags)] }); }
  async unsave(id: string, reelId: string): Promise<void> { await this.mutableWorkspace(id); await this.rpc('set_bookmark', { p_workspace_id: id, p_reel_id: reelId, p_saved: false }); }
  async transcript(id: string, reelId: string): Promise<ReelTranscript> {
    await this.workspace(id);
    // This read-only RPC independently enforces owner, workspace and creator association.
    return this.rpc('get_reel_transcript', { p_workspace_id: id, p_reel_id: reelId });
  }
  async transcription(): Promise<TranscriptOverview> { return this.rpc('get_transcription_overview'); }
  async transcriptionPreferences(paused: boolean): Promise<TranscriptOverview> {
    if (typeof paused !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Pause must be a boolean.');
    await this.rpc('update_transcription_preferences', { p_paused: paused });
    return this.transcription();
  }
  async transcriptionSettings(patch: TranscriptionSettingsPatch): Promise<TranscriptOverview> {
    const settings = validate(transcriptionSettingsSchema, patch);
    // Pause-only requests remain compatible with the previous backend.
    if (settings.monthly_budget_usd === undefined && settings.budget_warning_pct === undefined) return this.transcriptionPreferences(settings.paused!);
    await this.rpc('update_transcription_settings', { p_settings: settings });
    return this.transcription();
  }
  async jobs() { const data = await this.bootstrap(); return { jobs: data.jobs, usage: data.usage }; }
  async collectionHolds(page: number, limit: number): Promise<CollectionHolds> {
    const input = validate(collectionHoldsQuerySchema, { page, limit });
    return safeCollectionHolds(await this.rpc('get_collection_holds', { p_page: input.page, p_limit: input.limit }));
  }
  async collectionJobRecovery(jobId: string): Promise<CollectionJobRecovery> {
    return safeCollectionJobRecovery(await this.rpc('get_collection_job_recovery', { p_job_id: validate(idSchema, jobId) }));
  }
  async settleCollectionJob(jobId: string, input: CollectionSettlementRequest): Promise<CollectionJobRecovery> {
    const body = validate(collectionSettlementSchema, input);
    const id = validate(idSchema, jobId);
    await this.rpc('collection_settle_job', { p_job_id: id, p_outcome: body.outcome, p_reason: body.reason,
      p_evidence_reference: 'owner_ui_explicit_decision', p_idempotency_key: body.idempotency_key,
      p_expected_version: body.expected_version, p_acknowledge_unknown: body.acknowledge_unknown });
    // Read authoritative state after commit; never infer a zero bill or cleared recovery.
    return this.collectionJobRecovery(id);
  }
  async refresh(id: string, creatorIds?: string[]) {
    await this.mutableWorkspace(id);
    const collection = await this.collectionState(id, creatorIds);
    const result = await this.rpc<{ job_ids: string[] }>('enqueue_refresh', { p_workspace_id: id, p_creator_ids: creatorIds ? [...new Set(creatorIds)] : null, p_kind: 'manual' });
    const newIds = result.job_ids ?? [];
    const existingIds = [...collection.pending_job_ids, ...collection.active_job_ids];
    const jobIds = [...new Set([...newIds, ...existingIds])];
    if (!jobIds.length) throw new ApiError(409, 'NO_JOB_ENQUEUED', 'No eligible collection work was found. Check competitors, scraping setup, and Jobs.');
    const blocked = collection.reason !== null && !['usage_unverified', 'concurrency_limit', 'initial_import_disabled'].includes(collection.reason);
    const wake = !blocked && (newIds.length > 0 || collection.pending_job_ids.length > 0);
    return { job_id: jobIds[0], job_ids: jobIds, reused: newIds.length === 0, wake_dispatcher: wake, collection_state: collection,
      processing: blocked ? 'blocked' as const : !wake ? 'in_progress' as const : 'queued' as const,
      message: collection.reason ? collectionMessage(collection.reason) : newIds.length ? 'Refresh jobs queued. Existing data remains available.' : wake ? 'Existing queued imports preserved; background processing will be woken without creating duplicates.' : 'Collection is already in progress. No duplicate run was requested.' };
  }
  async settings(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (patch.scraping_enabled !== undefined) throw new ApiError(403, 'SCRAPING_SETUP_REQUIRED', 'Scraping cannot be enabled by browser requests.');
    if (patch.initial_backfill_enabled !== undefined || patch.initial_backfill_limit !== undefined) throw new ApiError(403, 'INITIAL_BACKFILL_READ_ONLY', 'Initial import setup is server-managed and its limit is fixed at 100.');
    // Timezone is fixed for the MVP. Do not forward this redundant field to older SQL RPCs.
    const settings = { ...validate(settingsSchema, patch) };
    delete settings.timezone;
    if (!Object.keys(settings).length) return (await this.bootstrap()).settings;
    return this.rpc('update_settings', { p_settings: settings });
  }
  async creatorSourceRefresh(id: string, creatorId: string): Promise<CreatorSourceRefresh | null> {
    await this.workspace(id);
    return this.rpc('get_creator_source_refresh', { p_workspace_id: id, p_creator_id: validate(idSchema, creatorId) });
  }
  async requestCreatorSourceRefresh(id: string, creatorId: string) {
    await this.mutableWorkspace(id);
    const result = await this.rpc<{ job_id?: string | null; job_ids?: string[]; reason?: string }>('request_creator_source_refresh', {
      p_workspace_id: id, p_creator_id: validate(idSchema, creatorId),
    });
    const jobId = result.job_id ?? result.job_ids?.[0];
    if (!jobId) {
      const messages: Record<string, string> = {
        creator_busy: 'This competitor already has an active or unresolved collection. Check Jobs before starting another refresh.',
        source_coverage_limit: 'This competitor has more than 100 stored Reels. A full history refresh needs a larger collection window; no incomplete refresh was started.',
        budget_paused: 'The current budget cannot reserve another source refresh. Check spending in Settings.',
      };
      throw new ApiError(409, 'SOURCE_REFRESH_BLOCKED', messages[result.reason ?? ''] ?? 'Source refresh could not be queued. Check collection and transcription setup in Settings.');
    }
    return { job_id: validate(idSchema, jobId), job_ids: [jobId], message: 'Full details refresh queued. Captions and media will be checked, and eligible failed transcripts retried.' };
  }
}
