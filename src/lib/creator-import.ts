export const MAX_BULK_CREATORS = 1000;
export const MAX_BULK_CREATOR_INPUT = 100_000;

/** Adapt a pasted list to the existing authenticated, transactional CSV import. */
export function creatorListToCsv(input: string): string {
  if (input.length > MAX_BULK_CREATOR_INPUT) throw new Error('This list is too long. Paste a smaller batch of profiles.');
  const entries = input.split(/[,\r\n]+/).map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error('Paste at least one Instagram username or profile link.');
  if (entries.length > MAX_BULK_CREATORS) throw new Error('Add up to 1,000 profiles at a time. Split this list into smaller batches.');

  // Keep every entry, including invalid ones, for server validation and review.
  // Quote cells directly: export escaping would alter leading @ in usernames.
  return 'username\n' + entries.map(entry => `"${entry.replaceAll('"', '""')}"`).join('\n');
}
