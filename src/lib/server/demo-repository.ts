import type { CollectionHolds, CollectionJobRecovery, CollectionSettlementRequest } from '../types';
import { settingsSchema as importSettingsSchema, collectionHoldsQuerySchema, collectionSettlementSchema } from './validation';
import { syntheticCollectionCapacity } from '../metrics';
import type { CreatorQuery, CreatorDirectoryEntry, CreatorCollectionSummary, CarouselSummary } from '../types';
import { creatorQuerySchema } from './validation';
import { safeCreatorPage, safeCreatorRead, safeCreatorDirectory, safeCollectionSummary, safeCarouselSummaryPage } from './public-data';
import { randomUUID } from 'node:crypto';
import { createDemoData } from '../demo';
import { engagementRate, followerOutlier, isStale, withProfileOutliers } from '../metrics';
import type { AppSettings, Bootstrap, Creator, Overview, PageResult, Reel, ReelDetail, ReelQuery, SavedReelFilter, ReelTranscript, TranscriptOverview, TranscriptionSettingsPatch, Usage, Workspace } from '../types';
import { resolveReelPeriod } from '../reel-filters';
import { idSchema, reelFilterSchema, transcriptionSettingsSchema, validate } from './validation';
import type { ImportResult, Repository } from './repository';
import { ApiError } from './errors';
import { parseCreatorCsv, previewCsv } from './csv';
import type { ReelCompletionStatus, ReelNeighbors } from '../types';
import type { Carousel, CarouselDetail, CarouselQuery, SavedCarouselFilter } from '../types';
import { carouselFilterSchema, carouselPeriod, carouselQuerySchema } from '../carousels';

type DemoData = ReturnType<typeof createDemoData>;
interface Saved { workspace_id: string; reel_id: string; note: string; tags: string[]; completion_status?: ReelCompletionStatus }
interface DemoState { data: DemoData; saved: Saved[]; reelFilters?: SavedReelFilter[]; carouselFilters?: SavedCarouselFilter[]; carouselSaved?: { workspace_id: string; carousel_id: string; note: string; tags: string[] }[] }
const globalStore = globalThis as typeof globalThis & { __reelradarDemo?: DemoState };
function state(): DemoState {
  if (!globalStore.__reelradarDemo) {
    const data = createDemoData();
    const saved = data.reels.filter(reel => reel.saved).flatMap(reel => data.workspaceCreators.filter(link => link.creator_id === reel.creator_id && link.active).map(link => ({ workspace_id: link.workspace_id, reel_id: reel.id, note: reel.note, tags: [...reel.tags] })));
    globalStore.__reelradarDemo = { data, saved };
  }
  return globalStore.__reelradarDemo;
}

function publishedOrder(a: Reel, b: Reel): number {
  if (a.published_at === null) return b.published_at === null ? 0 : 1;
  return b.published_at === null ? -1 : b.published_at.localeCompare(a.published_at);
}

/** All state stays server-side; synthetic records never cause network/provider calls. */
export class DemoRepository implements Repository {
  async profileAutomation(): Promise<import('../types').ProfileAutomationStatus> {
    return { enabled: false, provider_validated: false, paused: true, reason: 'disabled', interval_hours: 24, batch_limit: 20,
      due_creators: 0, pending_jobs: 0, active_jobs: 0, last_fetch_at: null, next_due_at: null };
  }
  private carouselHistory(id: string): Carousel[] {
    const ids = this.workspaceIds(id);
    return this.data.carousels.filter(post => ids.has(post.creator_id)).map(post => {
      const saved = this.store.carouselSaved?.find(item => item.workspace_id===id && item.carousel_id===post.id);
      return { ...post, saved: !!saved, note: saved?.note ?? '', tags: saved?.tags ?? [] };
    });
  }
  async carousels(id: string, input: CarouselQuery): Promise<PageResult<Carousel>> {
    const q = validate(carouselQuerySchema,input), page = q.page ?? 1, limit = q.limit ?? 30;
    const period = carouselPeriod(q);
    const from = period ? Date.parse(period.from + 'T00:00:00+05:30') : null;
    const until = period ? Date.parse(period.to + 'T00:00:00+05:30') + 86_400_000 : null;
    const inRange = (value: number | null, low?: number, high?: number) => (low === undefined && high === undefined) || value !== null && (low === undefined || value >= low) && (high === undefined || value <= high);
    const posts = this.carouselHistory(id).filter(post => (!q.creator || q.creator===post.creator_id) && (!q.saved || post.saved)
      && (q.creator_ids === undefined || q.creator_ids.includes(post.creator_id))
      && (!q.search || (post.caption+' '+post.username).toLowerCase().includes(q.search.toLowerCase()))
      && (!q.keywords || (post.caption+' '+post.username).toLowerCase().includes(q.keywords.toLowerCase()))
      && (q.min_interactions===undefined || post.interactions!==null && post.interactions>=q.min_interactions)
      && inRange(post.follower_outlier_score, q.min_outlier, q.max_outlier)
      && inRange(post.profile_outlier_score, q.min_profile_outlier, q.max_profile_outlier)
      && inRange(post.follower_engagement_pct, q.min_engagement, q.max_engagement)
      && (from === null || post.published_at !== null && Date.parse(post.published_at) >= from && Date.parse(post.published_at) < until!));
    const field = ({ latest:'published_at',likes:'latest_likes',comments:'latest_comments',profile_outlier:'profile_outlier_score',follower_engagement:'follower_engagement_pct' } as const)[q.sort ?? 'latest'];
    posts.sort((a,b) => {
      const left=a[field],right=b[field];
      return (left===null ? right===null ? 0 : 1 : right===null ? -1 : typeof left==='number' && typeof right==='number' ? right-left : String(right).localeCompare(String(left)))
        || String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')) || a.id.localeCompare(b.id);
    });
    return structuredClone({ items:posts.slice((page-1)*limit,page*limit),total:posts.length,page,limit });
  }
  async carouselSummaries(id: string, query: CarouselQuery): Promise<PageResult<CarouselSummary>> {
    const result = await this.carousels(id, query);
    return safeCarouselSummaryPage({ ...result, items: result.items.map(post => ({
      ...post, caption_preview: post.caption.slice(0, 500), slide_count: post.slides.length,
      thumbnail_url: post.thumbnail_url ?? post.slides[0]?.image_url ?? null,
    })) });
  }
  async carouselDetail(id: string, carouselId: string): Promise<CarouselDetail> {
    const carousel=this.carouselHistory(id).find(post=>post.id===carouselId);
    if (!carousel) throw new ApiError(404,'NOT_FOUND','Carousel not found.');
    return structuredClone({ carousel, snapshots:[{ fetched_at:carousel.latest_fetched_at,likes:carousel.latest_likes,comments:carousel.latest_comments,
      likes_state:carousel.likes_state,comments_state:carousel.comments_state,followers_at_snapshot:carousel.followers_count,follower_captured_at:carousel.follower_captured_at }] });
  }
  async saveCarousel(id: string, carouselId: string, saved: boolean, note='', tags: string[]=[]): Promise<void> {
    this.requireWorkspace(id,true); await this.carouselDetail(id,carouselId);
    if (note.length>4000 || tags.length>20 || tags.some(tag=>!tag.trim() || tag.trim().length>40)) throw new ApiError(400,'INVALID_INPUT','Check your research note and tags.');
    this.store.carouselSaved=(this.store.carouselSaved ?? []).filter(item=>item.workspace_id!==id || item.carousel_id!==carouselId);
    if (saved) this.store.carouselSaved.push({ workspace_id:id,carousel_id:carouselId,note,tags:[...new Set(tags.map(tag=>tag.trim()))] });
  }
  async carouselCollectionStatus(id: string): Promise<import('../types').CarouselCollectionStatus> {
    this.requireWorkspace(id);
    return { enabled: false, provider_validated: false, paused: true, reason: 'disabled', pending_jobs: 0, active_jobs: 0, last_fetch_at: null, next_due_at: null, interval_hours: 24, window_limit: 30 };
  }
  async refreshCarousels(id: string, creatorIds?: string[]): Promise<never> {
    this.requireWorkspace(id,true);
    if (creatorIds?.some(cid=>!this.workspaceIds(id).has(cid))) throw new ApiError(404,'NOT_FOUND','Competitor not found.');
    throw new ApiError(409,'SCRAPING_DISABLED','Demo carousels are synthetic. Collection is disabled and no provider was called.');
  }
  async carouselFilters(): Promise<SavedCarouselFilter[]> { return structuredClone(this.store.carouselFilters ?? []); }
  async createCarouselFilter(name: string, query: CarouselQuery): Promise<SavedCarouselFilter> {
    const body = validate(carouselFilterSchema, { name, query });
    const filters = this.store.carouselFilters ??= [];
    if (filters.some(filter => filter.name.toLowerCase() === body.name.toLowerCase())) throw new ApiError(409, 'DUPLICATE_FILTER', 'A saved filter with this name already exists.');
    if (filters.length >= 50) throw new ApiError(409, 'CAROUSEL_FILTER_LIMIT', 'You can save at most 50 carousel filters. Delete one before saving another.');
    const filter: SavedCarouselFilter = { id: randomUUID(), name: body.name, config: { version: 1, query: body.query }, created_at: new Date().toISOString() };
    filters.unshift(structuredClone(filter));
    return structuredClone(filter);
  }
  async deleteCarouselFilter(id: string): Promise<void> {
    validate(idSchema, id);
    const filters = this.store.carouselFilters ?? [];
    if (!filters.some(filter => filter.id === id)) throw new ApiError(404, 'NOT_FOUND', 'Saved carousel filter not found.');
    this.store.carouselFilters = filters.filter(filter => filter.id !== id);
  }
  private get store() { return state(); }
  private get data() { return this.store.data; }
  private get activeIds(): Set<string> {
    const workspaces = new Set(this.data.workspaces.filter(w => !w.archived_at).map(w => w.id));
    return new Set(this.data.workspaceCreators.filter(link => link.active && workspaces.has(link.workspace_id)).map(link => link.creator_id));
  }
  private requireWorkspace(id: string, mutable = false): Workspace {
    const workspace = this.data.workspaces.find(w => w.id === id);
    if (!workspace) throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
    if (mutable && workspace.archived_at) throw new ApiError(409, 'WORKSPACE_ARCHIVED', 'Restore the workspace before making changes.');
    return workspace;
  }
  private workspaceIds(id: string): Set<string> {
    this.requireWorkspace(id);
    return new Set(this.data.workspaceCreators.filter(link => link.workspace_id === id && link.active).map(link => link.creator_id));
  }
  private usage(): Usage {
    return { estimated_month_spend: 0, actual_month_spend: null, reserved_usd: 0, unreconciled_jobs: 0, remaining_allowance: this.data.settings.monthly_budget_usd, provider_balance_usd: null, reconciled_month_spend_usd: 0, risk_released_exposure_usd: 0 };
  }
  async bootstrap(): Promise<Bootstrap> {
    return structuredClone({ mode: 'demo', email: 'local-demo@reelradar.invalid', workspaces: this.data.workspaces, settings: { ...this.data.settings, collection_job_cap_usd: this.data.settings.collection_job_cap_usd ?? .1, scraping_enabled: false, initial_backfill_limit: 100, initial_backfill_enabled: false }, usage: this.usage(), jobs: this.data.jobs.slice(0, 50), collection_capacity: syntheticCollectionCapacity(this.data.jobs) });
  }
  async workspace(id: string): Promise<Workspace> { return structuredClone(this.requireWorkspace(id)); }
  private annotatedReels(id: string): Reel[] {
    const ids = this.workspaceIds(id);
    return withProfileOutliers(this.data.reels.filter(reel => ids.has(reel.creator_id))).map(reel => {
      const saved = this.store.saved.find(item => item.workspace_id === id && item.reel_id === reel.id);
      return { ...reel, saved: !!saved, completion_status: saved?.completion_status ?? 'pending', note: saved?.note ?? '', tags: [...(saved?.tags ?? [])],
        engagement_rate_pct: engagementRate(reel.views_state === 'known' ? reel.latest_views : null, reel.likes_state === 'known' ? reel.latest_likes : null, reel.comments_state === 'known' ? reel.latest_comments : null),
        follower_outlier_score: followerOutlier(reel.views_state === 'known' ? reel.latest_views : null, reel.likes_state === 'known' ? reel.latest_likes : null, reel.comments_state === 'known' ? reel.latest_comments : null, reel.followers_count),
      };
    });
  }
  async creators(id: string): Promise<Creator[]> {
    const ids = this.workspaceIds(id);
    return this.data.creators.filter(creator => ids.has(creator.id)).map(creator => {
      const reels = this.data.reels.filter(reel => reel.creator_id === creator.id);
      return { ...creator, tracked_reels: reels.length, tracked_carousels: this.data.carousels.filter(post => post.creator_id === creator.id).length,
        latest_reel_date: reels.reduce<string | null>((latest, reel) => reel.published_at !== null && (!latest || reel.published_at > latest) ? reel.published_at : latest, null) };
    });
  }
  private enrichedCreator(creator: Creator): Creator {
    const reels = this.data.reels.filter(reel => reel.creator_id === creator.id);
    return safeCreatorRead({ ...creator, tracked_reels: reels.length,
      tracked_carousels: this.data.carousels.filter(post => post.creator_id === creator.id).length,
      latest_reel_date: reels.reduce<string | null>((latest, reel) => reel.published_at !== null && (!latest || reel.published_at > latest) ? reel.published_at : latest, null),
      initial_backfill_job_id: creator.initial_backfill_job_id ?? null, initial_backfill_status: creator.initial_backfill_status ?? null });
  }
  async queryCreators(id: string, input: CreatorQuery): Promise<PageResult<Creator>> {
    const ids = this.workspaceIds(id), query = validate(creatorQuerySchema, input), page = query.page ?? 1, limit = query.limit ?? 50;
    const search = query.search?.toLowerCase() ?? '';
    const rows = this.data.creators.filter(creator => ids.has(creator.id) && `${creator.username} ${creator.display_name ?? ''}`.toLowerCase().includes(search))
      .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0) || a.id.localeCompare(b.id));
    return safeCreatorPage({ items: rows.slice((page - 1) * limit, page * limit).map(creator => this.enrichedCreator(creator)), total: rows.length, page, limit });
  }
  async creatorDirectory(id: string): Promise<CreatorDirectoryEntry[]> {
    const ids = this.workspaceIds(id);
    return safeCreatorDirectory(this.data.creators.filter(creator => ids.has(creator.id))
      .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0) || a.id.localeCompare(b.id)));
  }
  async creator(id: string, creatorId: string): Promise<Creator> {
    const ids = this.workspaceIds(id);
    const creator = this.data.creators.find(row => row.id === validate(idSchema, creatorId) && ids.has(row.id));
    if (!creator) throw new ApiError(404, 'NOT_FOUND', 'Competitor not found.');
    return this.enrichedCreator(creator);
  }
  async collectionSummary(id: string): Promise<CreatorCollectionSummary> {
    this.requireWorkspace(id);
    return safeCollectionSummary({ reason: 'scraping_disabled', blocking_job_id: null, pending_jobs: 0, active_jobs: 0 });
  }
  async overview(id: string): Promise<Overview> {
    const creators = await this.creators(id);
    const reels = this.annotatedReels(id);
    const valid = reels.map(reel => reel.engagement_rate_pct).filter((score): score is number => score !== null);
    const lastRefresh = creators.reduce<string | null>((latest, creator) => creator.last_reels_fetch_at && (!latest || creator.last_reels_fetch_at > latest) ? creator.last_reels_fetch_at : latest, null);
    return { active_competitors: creators.filter(creator => creator.status === 'active').length, tracked_reels: reels.length, outliers: reels.filter(reel => reel.follower_outlier_score !== null && reel.follower_outlier_score >= 10).length,
      average_engagement: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null,
      last_refresh: lastRefresh, stale_reels: reels.filter(reel => isStale(reel.latest_fetched_at)).length,
      leaderboard: creators.map(creator => {
        const scores = reels.filter(reel => reel.creator_id === creator.id).map(reel => reel.follower_outlier_score).filter((score): score is number => score !== null);
        return { creator, outliers: scores.filter(score => score >= 10).length, best_score: scores.length ? Math.max(...scores) : null };
      }).sort((a, b) => b.outliers - a.outliers || (b.best_score ?? -1) - (a.best_score ?? -1)).slice(0, 8),
      recent: reels.sort(publishedOrder).slice(0, 8),
    };
  }
  private makeCreator(username: string): Creator {
    return { id: randomUUID(), username, display_name: null, avatar_url: null, followers_count: null, last_profile_fetch_at: null, status: 'pending', last_reels_fetch_at: null, last_error: null };
  }
  private link(workspaceId: string, creator: Creator): void {
    const link = this.data.workspaceCreators.find(link => link.workspace_id === workspaceId && link.creator_id === creator.id);
    if (link) link.active = true;
    else this.data.workspaceCreators.push({ workspace_id: workspaceId, creator_id: creator.id, active: true });
  }
  async addCreator(id: string, username: string): Promise<Creator> {
    this.requireWorkspace(id, true);
    let creator = this.data.creators.find(creator => creator.username === username);
    if (creator && this.workspaceIds(id).has(creator.id)) throw new ApiError(409, 'DUPLICATE_CREATOR', 'This creator is already in the workspace.');
    if ((!creator || !this.activeIds.has(creator.id)) && this.activeIds.size >= this.data.settings.capacity) throw new ApiError(409, 'CAPACITY_EXCEEDED', 'Active creator capacity has been reached.');
    if (!creator) { creator = this.makeCreator(username); this.data.creators.push(creator); }
    this.link(id, creator);
    return { ...creator, tracked_reels: this.data.reels.filter(reel => reel.creator_id === creator!.id).length,
      tracked_carousels: this.data.carousels.filter(post => post.creator_id === creator!.id).length };
  }
  async removeCreator(id: string, creatorId: string): Promise<void> {
    this.requireWorkspace(id, true);
    const link = this.data.workspaceCreators.find(link => link.workspace_id === id && link.creator_id === creatorId && link.active);
    if (!link) throw new ApiError(404, 'NOT_FOUND', 'Creator is not linked to this workspace.');
    link.active = false;
    this.store.saved = this.store.saved.filter(saved => saved.workspace_id !== id || !this.data.reels.some(reel => reel.id === saved.reel_id && reel.creator_id === creatorId));
  }
  async importCreators(id: string, csv: string, preview: boolean): Promise<ImportResult> {
    const workspace = this.requireWorkspace(id, true);
    const existing = new Map<string, Set<string>>();
    for (const item of this.data.workspaces.filter(w => !w.archived_at)) {
      existing.set(item.name.toLowerCase(), new Set(this.data.creators.filter(creator => this.workspaceIds(item.id).has(creator.id)).map(creator => creator.username)));
    }
    const rows = previewCsv(parseCreatorCsv(csv, workspace.name), existing);
    const ready = rows.filter(row => row.status === 'ready');
    if (!preview) {
      for (const row of ready) if (this.data.workspaces.some(item => item.name.toLowerCase() === row.workspace.toLowerCase() && item.archived_at)) throw new ApiError(409, 'WORKSPACE_ARCHIVED', 'A destination workspace is archived.');
      const newDestinations = new Set(ready.map(row => row.workspace.toLowerCase()).filter(name => !this.data.workspaces.some(item => item.name.toLowerCase() === name)));
      if (this.data.workspaces.length + newDestinations.size > 100) throw new ApiError(409, 'WORKSPACE_LIMIT', 'This import would exceed the workspace limit. No rows were added.');
      const activeUsernames = new Set(this.data.creators.filter(creator => this.activeIds.has(creator.id)).map(creator => creator.username));
      for (const row of ready) activeUsernames.add(row.username!);
      if (activeUsernames.size > this.data.settings.capacity) throw new ApiError(409, 'CAPACITY_EXCEEDED', 'This import would exceed active creator capacity. No rows were added.');
      // Validation and commit are synchronous together: no partial state on capacity failures.
      for (const row of ready) {
        let target = this.data.workspaces.find(item => item.name.toLowerCase() === row.workspace.toLowerCase());
        if (!target) { target = this.makeWorkspace(row.workspace); this.data.workspaces.push(target); }
        let creator = this.data.creators.find(item => item.username === row.username);
        if (!creator) { creator = this.makeCreator(row.username!); this.data.creators.push(creator); }
        this.link(target.id, creator);
      }
    }
    return { rows, added: preview ? 0 : ready.length, duplicates: rows.filter(row => row.status === 'duplicate').length, invalid: rows.filter(row => row.status === 'invalid').length };
  }
  private makeWorkspace(name: string): Workspace {
    const id = randomUUID();
    return { id, name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workspace'}-${id.slice(0, 8)}`, created_at: new Date().toISOString(), archived_at: null };
  }
  async createWorkspace(name: string): Promise<Workspace> {
    if (this.data.workspaces.length >= 100) throw new ApiError(409, 'WORKSPACE_LIMIT', 'Workspace limit has been reached.');
    if (this.data.workspaces.some(workspace => workspace.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, 'DUPLICATE_WORKSPACE', 'A workspace with this name already exists.');
    const workspace = this.makeWorkspace(name);
    this.data.workspaces.push(workspace);
    return structuredClone(workspace);
  }
  async updateWorkspace(id: string, patch: { name?: string; archived?: boolean }): Promise<Workspace> {
    const workspace = this.requireWorkspace(id);
    if (patch.name && this.data.workspaces.some(w => w.id !== id && w.name.toLowerCase() === patch.name!.toLowerCase())) throw new ApiError(409, 'DUPLICATE_WORKSPACE', 'A workspace with this name already exists.');
    if (patch.archived === false && workspace.archived_at) {
      const ids = this.activeIds;
      for (const link of this.data.workspaceCreators.filter(link => link.workspace_id === id && link.active)) ids.add(link.creator_id);
      if (ids.size > this.data.settings.capacity) throw new ApiError(409, 'CAPACITY_EXCEEDED', 'Restoring this workspace would exceed active creator capacity.');
    }
    if (patch.name) workspace.name = patch.name;
    if (patch.archived !== undefined) workspace.archived_at = patch.archived ? new Date().toISOString() : null;
    return structuredClone(workspace);
  }
  private orderedReels(id: string, query: ReelQuery): Reel[] {
    query = resolveReelPeriod(query);
    let reels = this.annotatedReels(id);
    const search = query.search?.toLowerCase(), keywords = query.keywords?.toLowerCase();
    const creatorIds = query.creator_ids === undefined ? undefined : new Set(query.creator_ids);
    reels = reels.filter(reel => (!search || `${reel.username} ${reel.caption_preview}`.toLowerCase().includes(search)) &&
      (!keywords || reel.caption_preview.toLowerCase().includes(keywords)) &&
      (!query.creator_id || reel.creator_id === query.creator_id) &&
      (creatorIds === undefined || creatorIds.has(reel.creator_id)) &&
      (!query.platform || (reel.platform ?? 'instagram') === query.platform) &&
      (query.min_views === undefined || (reel.views_state === 'known' && reel.latest_views !== null && reel.latest_views >= query.min_views)) &&
      (query.max_views === undefined || (reel.views_state === 'known' && reel.latest_views !== null && reel.latest_views <= query.max_views)) &&
      (query.min_engagement === undefined || (reel.engagement_rate_pct !== null && reel.engagement_rate_pct >= query.min_engagement)) &&
      (query.max_engagement === undefined || (reel.engagement_rate_pct !== null && reel.engagement_rate_pct <= query.max_engagement)) &&
      (query.min_outlier === undefined || (reel.follower_outlier_score !== null && reel.follower_outlier_score >= query.min_outlier)) &&
      (query.max_outlier === undefined || (reel.follower_outlier_score !== null && reel.follower_outlier_score <= query.max_outlier)) &&
      (query.min_profile_outlier === undefined || (reel.profile_outlier_score !== null && reel.profile_outlier_score >= query.min_profile_outlier)) &&
      (query.max_profile_outlier === undefined || (reel.profile_outlier_score !== null && reel.profile_outlier_score <= query.max_profile_outlier)) &&
      (!query.from || (reel.published_at !== null && Date.parse(reel.published_at) >= Date.parse(`${query.from}T00:00:00+05:30`))) && (!query.to || (reel.published_at !== null && Date.parse(reel.published_at) < Date.parse(`${query.to}T00:00:00+05:30`) + 86_400_000)) &&
      (query.saved === undefined || reel.saved === query.saved) &&
      (!query.status || reel.creator_status === query.status) &&
      (!query.freshness || query.freshness === 'all' || isStale(reel.latest_fetched_at) === (query.freshness === 'stale')));
    const field = { published_at: 'published_at', views: 'latest_views', likes: 'latest_likes', comments: 'latest_comments', engagement: 'engagement_rate_pct', outlier: 'follower_outlier_score', profile_outlier: 'profile_outlier_score' }[query.sort ?? 'published_at'] as keyof Reel;
    reels.sort((a, b) => {
      const left = a[field], right = b[field];
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      const order = typeof left === 'number' && typeof right === 'number' ? right - left : String(right ?? '').localeCompare(String(left ?? ''));
      return order || (query.sort === 'profile_outlier' ? 0 : publishedOrder(a, b)) || a.id.localeCompare(b.id);
    });
    return reels;
  }
  async reels(id: string, query: ReelQuery): Promise<PageResult<Reel>> {
    const reels = this.orderedReels(id, query), page = query.page ?? 1, limit = query.limit ?? 30;
    return { items: structuredClone(reels.slice((page - 1) * limit, page * limit)), total: reels.length, page, limit };
  }
  async reelNeighbors(id: string, reelId: string, query: ReelQuery): Promise<ReelNeighbors> {
    const reels = this.orderedReels(id, query), index = reels.findIndex(reel => reel.id === reelId);
    return { previous_id: index > 0 ? reels[index - 1].id : null, next_id: index >= 0 ? reels[index + 1]?.id ?? null : null, position: index >= 0 ? index + 1 : null, total: reels.length };
  }
  async setCompletion(id: string, reelId: string, status: ReelCompletionStatus): Promise<void> {
    this.requireWorkspace(id, true);
    if (!['pending', 'done'].includes(status)) throw new ApiError(400, 'INVALID_INPUT', 'Choose Pending or Done.');
    const saved = this.store.saved.find(saved => saved.workspace_id === id && saved.reel_id === reelId);
    if (!saved || !this.annotatedReels(id).some(reel => reel.id === reelId)) throw new ApiError(404, 'NOT_FOUND', 'Saved Reel not found in this workspace.');
    saved.completion_status = status;
  }
  async reelFilters(): Promise<SavedReelFilter[]> { return structuredClone(this.store.reelFilters ?? []); }
  async createReelFilter(name: string, query: ReelQuery): Promise<SavedReelFilter> {
    const body = validate(reelFilterSchema, { name, query });
    const filters = this.store.reelFilters ??= [];
    if (filters.some(filter => filter.name.toLowerCase() === body.name.toLowerCase())) throw new ApiError(409, 'DUPLICATE_FILTER', 'A saved filter with this name already exists.');
    if (filters.length >= 50) throw new ApiError(409, 'REEL_FILTER_LIMIT', 'You can save at most 50 reel filters. Delete one before saving another.');
    const filter: SavedReelFilter = { id: randomUUID(), name: body.name, config: { version: 1, query: body.query }, created_at: new Date().toISOString() };
    filters.unshift(structuredClone(filter));
    return structuredClone(filter);
  }
  async deleteReelFilter(id: string): Promise<void> {
    validate(idSchema, id);
    const filters = this.store.reelFilters ?? [];
    if (!filters.some(filter => filter.id === id)) throw new ApiError(404, 'NOT_FOUND', 'Saved reel filter not found.');
    this.store.reelFilters = filters.filter(filter => filter.id !== id);
  }
  async save(id: string, reelId: string, note: string, tags: string[]): Promise<void> {
    this.requireWorkspace(id, true);
    if (!this.annotatedReels(id).some(reel => reel.id === reelId)) throw new ApiError(404, 'NOT_FOUND', 'Reel not found in this workspace.');
    const old = this.store.saved.find(saved => saved.workspace_id === id && saved.reel_id === reelId);
    const patch = { workspace_id: id, reel_id: reelId, note, tags: [...new Set(tags)] };
    if (old) Object.assign(old, patch); else this.store.saved.push(patch);
  }
  async unsave(id: string, reelId: string): Promise<void> {
    this.requireWorkspace(id, true);
    this.store.saved = this.store.saved.filter(saved => !(saved.workspace_id === id && saved.reel_id === reelId));
  }
  async transcript(id: string, reelId: string): Promise<ReelTranscript> {
    if (!this.annotatedReels(id).some(reel => reel.id === reelId)) throw new ApiError(404, 'NOT_FOUND', 'Reel not found in this workspace.');
    return { reel_id: reelId, status: 'not_requested', text: null, language: null, segments: [], model: null, completed_at: null, error_message: null };
  }
  async reelDetail(id: string, reelId: string): Promise<ReelDetail> {
    const reel = this.annotatedReels(id).find(reel => reel.id === reelId);
    if (!reel) throw new ApiError(404, 'NOT_FOUND', 'Reel not found in this workspace.');
    return { reel: structuredClone(reel), caption_full: reel.caption_preview, media: { urls: [], observed_at: null }, transcript: await this.transcript(id, reelId), processing: { request_allowed: false, reason: 'demo', estimate: null } };
  }
  async requestTranscript(id: string, reelId: string): Promise<ReelDetail> {
    this.requireWorkspace(id, true);
    return this.reelDetail(id, reelId);
  }
  async transcription(): Promise<TranscriptOverview> {
    return { enabled: false, paused: true, monthly_budget_usd: 5, pilot_limit_usd: 0.25, phase: 'pilot', estimated_month_spend: 0, reserved_usd: 0, actual_month_spend: null, unreconciled_jobs: 0, jobs: [], budget_warning_pct: 80, preferences_editable: false, pilot_verified: false, account_pricing_validated: false, processing_ready: false, accounted_month_spend: 0, job_counts: {}, spending_warning: false };
  }
  async transcriptionPreferences(paused: boolean): Promise<TranscriptOverview> {
    if (typeof paused !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Pause must be a boolean.');
    // Demo never enables processing or changes server authorization.
    return this.transcription();
  }
  async transcriptionSettings(patch: TranscriptionSettingsPatch): Promise<TranscriptOverview> {
    validate(transcriptionSettingsSchema, patch);
    return this.transcription();
  }
  async apifyAccounts(): Promise<import('../types').ApifyAccountsStatus> {
    return { ready_accounts: 0, accounts: ([1, 2, 3, 4, 5] as const).map(slot => ({ slot, label: `Account ${slot}`, enabled: false, configured: false,
      reason: 'disabled', usage_usd: null, limit_usd: null, usage_checked_at: null, cycle_end_at: null, reserved_usd: 0, unreconciled_jobs: 0 })) };
  }
  async jobs() { return structuredClone({ jobs: this.data.jobs.slice(0, 50), usage: this.usage() }); }
  async collectionHolds(page: number, limit: number): Promise<CollectionHolds> {
    validate(collectionHoldsQuerySchema, { page, limit });
    // Demo has no real reservations or unknown provider liability.
    return { items: [], total: 0, page, limit, capacity: syntheticCollectionCapacity(this.data.jobs), usage: { reconciled_month_spend_usd: 0, risk_released_exposure_usd: 0 } };
  }
  async collectionJobRecovery(jobId: string): Promise<CollectionJobRecovery> {
    validate(idSchema, jobId);
    throw new ApiError(404, 'NOT_FOUND', 'Synthetic demo activity has no provider recovery holds.');
  }
  async settleCollectionJob(jobId: string, input: CollectionSettlementRequest): Promise<CollectionJobRecovery> {
    validate(idSchema, jobId); validate(collectionSettlementSchema, input);
    throw new ApiError(409, 'DEMO_ONLY', 'Synthetic demo activity has no real provider liability to settle. No provider was called.');
  }
  async collectionState(id: string, creatorIds?: string[]): Promise<import('../types').CreatorCollectionState> {
    this.requireWorkspace(id);
    const ids = this.workspaceIds(id);
    if (creatorIds?.some(creatorId => !ids.has(creatorId))) throw new ApiError(404, 'NOT_FOUND', 'A selected creator is not in this workspace.');
    return { reason: 'scraping_disabled', blocking_job_id: null, pending_job_ids: [], active_job_ids: [], profiles: [] };
  }
  async refresh(id: string, creatorIds?: string[]) {
    this.requireWorkspace(id, true);
    // Automatic scheduling pause does not block an explicitly requested manual refresh.
    const ids = this.workspaceIds(id);
    const requested = new Set(creatorIds ?? [...ids]);
    if (!requested.size) throw new ApiError(400, 'NO_CREATORS', 'Add a creator before refreshing.');
    if ([...requested].some(creatorId => !ids.has(creatorId))) throw new ApiError(404, 'NOT_FOUND', 'A selected creator is not in this workspace.');
    const now = new Date().toISOString();
    const jobId = randomUUID();
    for (const creator of this.data.creators.filter(creator => requested.has(creator.id))) creator.last_reels_fetch_at = now;
    for (const reel of this.data.reels.filter(reel => requested.has(reel.creator_id))) reel.latest_fetched_at = now;
    this.data.jobs.unshift({ id: jobId, kind: 'manual', status: 'succeeded', scheduled_for: now, started_at: now, completed_at: now, actor_run_id: null, requested_profiles_count: requested.size, results_limit: this.data.settings.daily_limit, returned_records_count: this.data.reels.filter(reel => requested.has(reel.creator_id)).length, estimated_cost_usd: 0, actual_cost_usd: null, error_message: null, attempt_count: 1 });
    this.data.jobs.splice(100);
    return { job_id: jobId, message: 'Synthetic demo refresh completed. No provider was called and no real data was fetched.' };
  }
  async settings(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (patch.scraping_enabled !== undefined) throw new ApiError(403, 'SCRAPING_SETUP_REQUIRED', 'Scraping cannot be enabled by browser requests.');
    if (patch.initial_backfill_enabled !== undefined || patch.initial_backfill_limit !== undefined) throw new ApiError(403, 'INITIAL_BACKFILL_READ_ONLY', 'Initial import setup is server-managed and its limit is fixed at 100.');
    if (patch.capacity !== undefined && patch.capacity < this.activeIds.size) throw new ApiError(409, 'CAPACITY_EXCEEDED', 'Capacity cannot be smaller than the active creator count.');
    Object.assign(this.data.settings, { collection_job_cap_usd: this.data.settings.collection_job_cap_usd ?? .1 }, validate(importSettingsSchema, patch), { scraping_enabled: false });
    return structuredClone(this.data.settings);
  }
  async creatorSourceRefresh(id: string, creatorId: string) {
    this.requireWorkspace(id);
    if (!this.workspaceIds(id).has(creatorId)) throw new ApiError(404, 'NOT_FOUND', 'Competitor not found in this workspace.');
    return null;
  }
  async requestCreatorSourceRefresh(id: string, creatorId: string): Promise<import('./repository').RefreshResult> {
    await this.creatorSourceRefresh(id, creatorId);
    throw new ApiError(409, 'DEMO_ONLY', 'Synthetic demo Reels cannot be refreshed from Instagram.');
  }
}
