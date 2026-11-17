import type { AppSettings, Creator, Job, Reel, Workspace, Carousel } from './types';
import { engagementRate, followerOutlier, withProfileOutliers, withCarouselMetrics } from './metrics';

export function demoId(category: number, index: number): string {
  return `${category.toString(16).padStart(8, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

export function createDemoData() {
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const workspaces: Workspace[] = ['AI Tools', 'Business Ideas', 'Design & Creativity'].map((name, i) => ({
    id: demoId(1, i + 1), name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), created_at: ago(720), archived_at: null,
  }));
  const seeds = [
    ['prompt.studio.demo', 'Prompt Studio', 24800], ['future.tools.demo', 'Future Tools', 61200],
    ['build.with.ai.demo', 'Build with AI', 18700], ['workflow.lab.demo', 'Workflow Lab', 42100],
    ['the.daily.ai.demo', 'The Daily AI', 93700], ['nocode.notes.demo', 'No-code Notes', 14300],
    ['ideas.in.motion.demo', 'Ideas in Motion', 38200], ['small.bet.demo', 'Small Bet', 27900],
    ['founder.fieldnotes.demo', 'Founder Fieldnotes', 81000], ['design.interval.demo', 'Design Interval', 31500],
    ['creative.systems.demo', 'Creative Systems', 22400], ['visual.archive.demo', 'Visual Archive', 57400],
  ] as const;
  const creators: Creator[] = seeds.map(([username, display_name, followers], i) => ({
    id: demoId(2, i + 1), username, display_name, avatar_url: null, followers_count: i === 5 ? null : followers,
    last_profile_fetch_at: i === 5 ? null : ago(48 + i), status: i === 10 ? 'private' : i === 8 ? 'failed' : 'active',
    last_reels_fetch_at: ago(i === 8 ? 74 : i === 10 ? 96 : 1.5 + i / 4),
    last_error: i === 8 ? 'Synthetic provider timeout. Historical data preserved.' : i === 10 ? 'Synthetic private-account scenario. No automatic retries.' : null,
  }));
  const workspaceCreators = creators.flatMap((creator, i) => {
    const workspaceIndexes = i < 6 ? [0] : i < 9 ? [1] : [2];
    if (i === 2 || i === 3) workspaceIndexes.push(1);
    if (i === 0) workspaceIndexes.push(2);
    return workspaceIndexes.map(index => ({ workspace_id: workspaces[index].id, creator_id: creator.id, active: true }));
  });
  const captions = [
    'Your next research workflow starts with one better question.',
    'Five small AI tools that quietly save hours every week.',
    'I rebuilt this entire workflow without writing a line of code.',
    'Stop collecting tools. Start building a system that works.',
    'The simplest way to turn a messy idea into a clear first draft.',
    'A practical experiment: one prompt, three very different results.',
    'What happens when you remove half the steps from your process?',
    'Three overlooked details that make this format worth studying.',
    'From blank page to working prototype: the 20-minute method.',
    'One useful idea, explained with an unexpectedly simple visual.',
    'The hook is not the whole story. Here is what keeps people watching.',
    'Save this checklist for the next time you start from scratch.',
  ];
  const reels: Reel[] = withProfileOutliers(creators.flatMap((creator, i) => Array.from({ length: 12 }, (_, j) => {
    let views: number | null = Math.round((creator.followers_count ?? 20000) * [24.5, 13.2, 10, 6.4, 3.8, 1.5, 0.9, 8.2, 0.5, 2.6, 5.2, 0][j] * (1 + i * 0.055));
    let likes: number | null = Math.round(views * [0.062, 0.042, 0.018, 0.05, 0.029, 0.012][j % 6]);
    let comments: number | null = Math.round(views * 0.0025);
    if (i === 0 && j === 2) { views = 240000; likes = 7600; comments = 400; }
    if (i === 0 && j === 3) { views = 160000; likes = 7500; comments = 500; }
    const likes_state = i === 1 && j === 4 ? 'hidden' : 'known';
    if (likes_state === 'hidden') likes = null;
    const comments_state = i === 2 && j === 5 ? 'not_fetched' : 'known';
    if (comments_state === 'not_fetched') comments = null;
    const views_state = i === 4 && j === 6 ? 'unavailable' : 'known';
    if (views_state === 'unavailable') views = null;
    return {
      id: demoId(3, i * 12 + j + 1), creator_id: creator.id, shortcode: `SYNTHETIC_${i}_${j}`,
      reel_url: null, thumbnail_url: null, caption_preview: captions[(j + i) % captions.length],
      published_at: ago(8 + j * 36 + i * 3), duration_seconds: 18 + (j * 7 + i) % 52,
      latest_views: views, latest_likes: likes, latest_comments: comments, views_state, likes_state, comments_state,
      latest_fetched_at: creator.last_reels_fetch_at!, first_seen_at: ago(8 + j * 36 + i * 3), provider: 'mock',
      username: creator.username, display_name: creator.display_name, avatar_url: null,
      followers_count: creator.followers_count, follower_captured_at: creator.last_profile_fetch_at,
      creator_status: creator.status, follower_outlier_score: followerOutlier(views, likes, comments, creator.followers_count),
      engagement_rate_pct: engagementRate(views, likes, comments), saved: false, note: '', tags: [],
    } satisfies Omit<Reel, 'profile_outlier_score' | 'profile_baseline_views' | 'profile_baseline_sample'>;
  })));
  const jobs: Job[] = [
    { id: demoId(4, 1), kind: 'daily', status: 'succeeded', scheduled_for: ago(2), started_at: ago(2), completed_at: ago(1.5), actor_run_id: null, requested_profiles_count: 10, returned_records_count: 100, estimated_cost_usd: 0.005, actual_cost_usd: null, error_message: null, attempt_count: 1 },
    { id: demoId(4, 2), kind: 'daily', status: 'partial', scheduled_for: ago(26), started_at: ago(26), completed_at: ago(25.5), actor_run_id: null, requested_profiles_count: 12, returned_records_count: 100, estimated_cost_usd: 0.006, actual_cost_usd: null, error_message: 'Synthetic example: one timeout and one private profile; history preserved.', attempt_count: 1 },
  ];
  const settings: AppSettings = { daily_limit: 10, weekly_limit: 30, monthly_budget_usd: 4, budget_warning_pct: 80, paused: true, timezone: 'Asia/Kolkata', capacity: 120, scraping_enabled: false };
  const carousels = withCarouselMetrics(creators.flatMap((creator, i) => Array.from({ length: 14 }, (_, j) => ({
    id: demoId(8, i * 14 + j + 1), creator_id: creator.id, shortcode: 'SYNTHETIC_CAROUSEL_'+i+'_'+j,
    post_url: null, thumbnail_url: '/demo/carousel-'+(i % 4 + 1)+'.svg',
    caption: captions[(i+j)%captions.length]+'\n\nSynthetic carousel research example. Save the structure, then adapt it to your own topic.',
    published_at: ago(12+j*48+i), published_at_raw: null, published_at_basis: 'explicit_offset' as const,
    slides: Array.from({ length: 4 }, (_, k) => ({ position: k+1, media_type: 'image' as const, image_url: '/demo/carousel-'+((k+i)%4+1)+'.svg', video_url: null })),
    latest_likes: i===2 && j===3 ? null : j===0 ? 14000+i*500 : 900+j*70+i*90,
    latest_comments: j===2 ? 0 : 25+j*8, likes_state: i===2 && j===3 ? 'hidden' as const : 'known' as const,
    comments_state: 'known' as const, latest_fetched_at: ago(i+2), provider: 'mock:synthetic',
    username: creator.username, display_name: creator.display_name, avatar_url: null,
    followers_count: creator.followers_count, follower_captured_at: creator.last_profile_fetch_at,
    saved: false, note: '', tags: [],
  } satisfies Omit<Carousel,'interactions'|'follower_engagement_pct'|'follower_outlier_score'|'profile_outlier_score'|'profile_baseline_interactions'|'profile_baseline_sample'>))));
  return { workspaces, creators, reels, carousels, workspaceCreators, jobs, settings };
}
