'use client';

import { useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, CheckCircle2, Link2, Loader2, Users } from 'lucide-react';
import { api, errorMessage } from '@/lib/client';
import { creatorListToCsv } from '@/lib/creator-import';
import type { ImportResult } from '@/lib/server/repository';
import { Avatar, Dialog, type Notify } from './ui';

type Preview = { csv: string; result: ImportResult };

export function BulkAddCreators({ base, workspaceName, notify, close, updated }: {
  base: string;
  workspaceName: string;
  notify: Notify;
  close: () => void;
  updated: () => void;
}) {
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<'parse' | 'add' | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ready = preview?.result.rows.filter(row => row.status === 'ready').length ?? 0;

  function dismiss() {
    if (!pending.current) close();
  }

  async function parse(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy('parse');
    setError('');
    setPreview(null);
    try {
      const csv = creatorListToCsv(input);
      const checked = await api<ImportResult>(`${base}/creators/import`, { method: 'POST', body: JSON.stringify({ csv, preview: true }) });
      setPreview({ csv, result: checked });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  async function add() {
    if (pending.current || !preview || !ready) return;
    pending.current = true;
    setBusy('add');
    setError('');
    try {
      // Submit exactly the reviewed list. The server rechecks duplicates and capacity.
      const added = await api<ImportResult>(`${base}/creators/import`, { method: 'POST', body: JSON.stringify({ csv: preview.csv, preview: false }) });
      setResult(added);
      updated();
      notify(`${added.added} ${added.added === 1 ? 'creator' : 'creators'} added to ${workspaceName}.${added.duplicates ? ` ${added.duplicates} duplicate ${added.duplicates === 1 ? 'entry' : 'entries'} skipped.` : ''}${added.invalid ? ` ${added.invalid} invalid ${added.invalid === 1 ? 'entry' : 'entries'} skipped.` : ''}`);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  function reset() {
    setInput('');
    setPreview(null);
    setResult(null);
    setError('');
  }

  return <Dialog title="Bulk add creators" subtitle={`Add Instagram profiles to ${workspaceName}.`} onClose={dismiss} wide>
    <div className="bulk-add-creators" aria-busy={Boolean(busy)}>
      {result ? <div className="bulk-add-result" role="status">
        <span className="bulk-result-icon"><CheckCircle2 size={28} aria-hidden="true"/></span>
        <h3>{result.added ? `${result.added} ${result.added === 1 ? 'creator' : 'creators'} added` : 'No new creators added'}</h3>
        <p>{result.added ? `Your creator list in ${workspaceName} is up to date.` : 'The valid profiles are already in this workspace.'}</p>
        {(result.duplicates > 0 || result.invalid > 0) && <p>{result.duplicates} duplicate {result.duplicates === 1 ? 'entry' : 'entries'} and {result.invalid} invalid {result.invalid === 1 ? 'entry' : 'entries'} skipped.</p>}
        {result.message && <p>{result.message}</p>}
      </div> : <>
        <form onSubmit={parse}>
          <label className="bulk-input-label" htmlFor="bulk-creator-input"><Link2 size={16} aria-hidden="true"/>Profile links or usernames</label>
          <p className="bulk-input-hint" id="bulk-creator-hint">Separate profiles with a new line or comma. You can mix links and usernames.</p>
          <div className="bulk-input-box">
            <textarea
              ref={inputRef}
              id="bulk-creator-input"
              aria-describedby="bulk-creator-hint bulk-creator-limit"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              rows={6}
              value={input}
              disabled={Boolean(busy)}
              placeholder={'https://www.instagram.com/creator_one/\n@creator_two\ncreator.three'}
              onChange={event => { setInput(event.target.value); setPreview(null); setError(''); }}
            />
            <div className="bulk-input-footer">
              <span id="bulk-creator-limit">Up to 1,000 profiles at a time</span>
              <button type="submit" className="button button-secondary" disabled={Boolean(busy) || !input.trim()}>
                {busy === 'parse' ? <Loader2 size={15} className="spin" aria-hidden="true"/> : <ArrowRight size={15} aria-hidden="true"/>}
                {busy === 'parse' ? 'Checking profiles…' : preview ? 'Parse again' : 'Parse profiles'}
              </button>
            </div>
          </div>
        </form>
        <p className="bulk-input-hint">Public Instagram profiles only. New profiles use a bounded initial 50-photo-post carousel window, keeping only carousels—not full history. Review the list before adding.</p>
        {preview && <section className="bulk-preview" aria-label="Creator preview">
          <div className="bulk-preview-summary" role="status">
            <strong><Users size={16} aria-hidden="true"/>{ready} ready to add</strong>
            <span>{preview.result.duplicates} duplicates</span>
            <span>{preview.result.invalid} invalid</span>
          </div>
          <ul className="bulk-preview-list" aria-label="Parsed creators">
            {preview.result.rows.map((row, index) => <li key={row.row}>
              {row.username ? <Avatar username={row.username} index={index}/> : <span className="bulk-invalid-icon"><AlertCircle size={18} aria-hidden="true"/></span>}
              <div className="bulk-preview-profile">
                <strong>{row.username ? `@${row.username}` : row.input}</strong>
                <span>{row.status === 'invalid' ? row.error : row.status === 'duplicate' ? 'Already in this workspace or repeated in this list.' : `instagram.com/${row.username}`}</span>
              </div>
              <span className={`bulk-row-status bulk-row-${row.status}`}>
                {row.status === 'ready' ? <Check size={14} aria-hidden="true"/> : row.status === 'invalid' ? <AlertCircle size={14} aria-hidden="true"/> : null}
                {row.status === 'ready' ? 'Ready' : row.status === 'duplicate' ? 'Duplicate' : 'Invalid'}
              </span>
            </li>)}
          </ul>
          <p className="bulk-review-note">{ready ? 'Only ready profiles will be added. Duplicates and invalid entries will be skipped.' : 'No new profiles to add. Edit the list above and parse it again.'}</p>
        </section>}
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {result ? <>
          <button type="button" className="button button-secondary" onClick={reset}>Add more</button>
          <button type="button" className="button button-accent" onClick={dismiss}>Done</button>
        </> : <>
          <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={dismiss}>Cancel</button>
          {preview && <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => inputRef.current?.focus()}>Edit list</button>}
          <button type="button" className="button button-accent" disabled={Boolean(busy) || !ready} onClick={add}>
            {busy === 'add' ? <Loader2 size={16} className="spin" aria-hidden="true"/> : <Users size={16} aria-hidden="true"/>}
            {busy === 'add' ? 'Adding creators…' : ready ? `Add ${ready} ${ready === 1 ? 'creator' : 'creators'}` : 'Add creators'}
          </button>
        </>}
      </div>
    </div>
  </Dialog>;
}
