import type { AppSettings, Bootstrap, Creator, Job, Overview, PageResult, QueueProcessing, Reel, ReelDetail, ReelQuery, SavedReelFilter, ReelTranscript, TranscriptOverview, TranscriptionSettingsPatch, Usage, Workspace } from '../types';
import type { CollectionHolds, CollectionJobRecovery, CollectionSettlementRequest } from '../types';
import type { ImportRow } from '../types';
import type { CreatorSourceRefresh } from '../types';
import type { ReelCompletionStatus, ReelNeighbors } from '../types';
import type { TranscriptRequest } from '../types';
import type { Carousel, CarouselDetail, CarouselQuery, SavedCarouselFilter } from '../types';

import type { CreatorCollectionState } from '../types';
import type { ApifyAccountsStatus } from '../types';
import type { CarouselCollectionStatus } from '../types';
import type { CreatorCollectionSummary, CreatorDirectoryEntry, CreatorQuery, CarouselSummary } from '../types';
import type { ProfileAutomationStatus } from '../types';
export interface ImportResult { rows: ImportRow[]; added: number; duplicates: number; invalid: number; job_ids?: string[]; profile_job_ids?: string[]; processing?: QueueProcessing; message?: string }
export interface CarouselRefreshMetadata {
  scope: 'workspace' | 'selected'; requested_creators: number; selection_limit: 120;
  // Legacy enqueue returns canonical job IDs, not new/reused job or fetched-post counts.
  new_jobs: number | null; reused_jobs: number | null;
  status_before_request: CarouselCollectionStatus;
}
export interface RefreshResult { job_id: string; job_ids?: string[]; message: string; processing?: QueueProcessing; reused?: boolean; wake_dispatcher?: boolean; collection_state?: CreatorCollectionState; carousel_collection?: CarouselRefreshMetadata }
export interface Repository {
  carouselSummaries(id: string, query: CarouselQuery): Promise<PageResult<CarouselSummary>>;
  carousels(id: string, query: CarouselQuery): Promise<PageResult<Carousel>>;
  carouselDetail(id: string, carouselId: string): Promise<CarouselDetail>;
  saveCarousel(id: string, carouselId: string, saved: boolean, note?: string, tags?: string[]): Promise<void>;
  refreshCarousels(id: string, creatorIds?: string[]): Promise<RefreshResult>;
  carouselCollectionStatus(id: string): Promise<CarouselCollectionStatus>;
  carouselFilters(): Promise<SavedCarouselFilter[]>;
  createCarouselFilter(name: string, query: CarouselQuery): Promise<SavedCarouselFilter>;
  deleteCarouselFilter(id: string): Promise<void>;
  bootstrap(): Promise<Bootstrap>;
  profileAutomation(): Promise<ProfileAutomationStatus>;
  apifyAccounts(): Promise<ApifyAccountsStatus>;
  workspace(id: string): Promise<Workspace>;
  overview(id: string): Promise<Overview>;
  creators(id: string): Promise<Creator[]>;
  queryCreators(id: string, query: CreatorQuery): Promise<PageResult<Creator>>;
  creatorDirectory(id: string): Promise<CreatorDirectoryEntry[]>;
  creator(id: string, creatorId: string): Promise<Creator>;
  collectionSummary(id: string): Promise<CreatorCollectionSummary>;
  collectionState(id: string, creatorIds?: string[]): Promise<CreatorCollectionState>;
  addCreator(id: string, username: string): Promise<Creator>;
  removeCreator(id: string, creatorId: string): Promise<void>;
  importCreators(id: string, csv: string, preview: boolean): Promise<ImportResult>;
  createWorkspace(name: string): Promise<Workspace>;
  updateWorkspace(id: string, patch: { name?: string; archived?: boolean }): Promise<Workspace>;
  reels(id: string, query: ReelQuery): Promise<PageResult<Reel>>;
  reelDetail(id: string, reelId: string): Promise<ReelDetail>;
  reelNeighbors(id: string, reelId: string, query: ReelQuery): Promise<ReelNeighbors>;
  requestTranscript(id: string, reelId: string, input?: TranscriptRequest): Promise<ReelDetail>;
  reelFilters(): Promise<SavedReelFilter[]>;
  createReelFilter(name: string, query: ReelQuery): Promise<SavedReelFilter>;
  deleteReelFilter(id: string): Promise<void>;
  transcript(id: string, reelId: string): Promise<ReelTranscript>;
  transcription(): Promise<TranscriptOverview>;
  transcriptionPreferences(paused: boolean): Promise<TranscriptOverview>;
  transcriptionSettings(patch: TranscriptionSettingsPatch): Promise<TranscriptOverview>;
  save(id: string, reelId: string, note: string, tags: string[]): Promise<void>;
  unsave(id: string, reelId: string): Promise<void>;
  setCompletion(id: string, reelId: string, status: ReelCompletionStatus): Promise<void>;
  jobs(): Promise<{ jobs: Job[]; usage: Usage }>;
  collectionHolds(page: number, limit: number): Promise<CollectionHolds>;
  collectionJobRecovery(jobId: string): Promise<CollectionJobRecovery>;
  settleCollectionJob(jobId: string, input: CollectionSettlementRequest): Promise<CollectionJobRecovery>;
  refresh(id: string, creatorIds?: string[]): Promise<RefreshResult>;
  creatorSourceRefresh(id: string, creatorId: string): Promise<CreatorSourceRefresh | null>;
  requestCreatorSourceRefresh(id: string, creatorId: string): Promise<RefreshResult>;
  settings(patch: Partial<AppSettings>): Promise<AppSettings>;
}
