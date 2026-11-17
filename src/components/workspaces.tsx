'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArrowUpRight, Pencil, Plus } from 'lucide-react';
import type { Bootstrap, Workspace } from '@/lib/types';
import { api, errorMessage } from '@/lib/client';
import { rememberWorkspace, workspaceSelectionKey } from '@/lib/workspace-selection';
import { formatDate } from '@/lib/format';
import { Dialog, Empty, SubmitButton, type Notify } from './ui';

export function Workspaces({ bootstrap, notify }: { bootstrap: Bootstrap; notify: Notify }) {
  const router = useRouter();
  function open(workspace: Workspace) {
    rememberWorkspace(workspaceSelectionKey(bootstrap.mode, bootstrap.email), workspace.id);
    router.push('/dashboard');
  }
  const [editing, setEditing] = useState<Workspace | 'new' | null>(null), [archiving, setArchiving] = useState<Workspace | null>(null), [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [showArchived, setShowArchived] = useState(false);
  const workspaces = bootstrap.workspaces.filter(workspace => showArchived || !workspace.archived_at);
  function edit(workspace: Workspace | 'new') { setEditing(workspace); setName(workspace === 'new' ? '' : workspace.name); setError(''); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!editing) return; setBusy(true); setError('');
    try { await api(`/api/workspaces${editing === 'new' ? '' : '/' + editing.id}`, { method: editing === 'new' ? 'POST' : 'PATCH', body: JSON.stringify({ name: name.trim() }) }); notify(editing === 'new' ? 'Workspace created.' : 'Workspace renamed.'); setEditing(null); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function archive(workspace: Workspace, archived: boolean) {
    setBusy(true);
    try { await api(`/api/workspaces/${workspace.id}`, { method: 'PATCH', body: JSON.stringify({ archived }) }); notify(archived ? 'Workspace archived. Research data is preserved.' : 'Workspace restored.'); setArchiving(null); }
    catch (error) { notify(errorMessage(error), 'error'); } finally { setBusy(false); }
  }
  return <>
    <div className="page-heading">
      <div><h1>Workspaces</h1></div>
      <button className="button button-accent" onClick={() => edit('new')}><Plus size={17}/>New workspace</button>
    </div>
    <div className="results-toolbar">
      <span><strong>{bootstrap.workspaces.filter(workspace => !workspace.archived_at).length}</strong> active workspaces</span>
      <label className="checkbox-field"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)}/>Show archived</label>
    </div>
    {workspaces.length ? <div className="workspace-grid">
      {workspaces.map(workspace => <article className={`workspace-card ${workspace.archived_at ? 'workspace-archived' : ''}`} key={workspace.id}>
        <div className="workspace-card-body">
          <h2>{workspace.name}</h2>
          <p>{workspace.archived_at ? 'Archived · ' : ''}Created {formatDate(workspace.created_at)}</p>
          <div className="workspace-actions">
            {workspace.archived_at ? <button className="text-link" disabled={busy} onClick={() => archive(workspace, false)}>Restore workspace</button> : <button className="text-link" onClick={() => open(workspace)}>Open workspace<ArrowUpRight size={16}/></button>}
            <div>
              <button className="icon-button" aria-label={`Rename ${workspace.name}`} onClick={() => edit(workspace)}><Pencil size={15}/></button>
              {!workspace.archived_at && <button className="icon-button" aria-label={`Archive ${workspace.name}`} onClick={() => setArchiving(workspace)}><Archive size={15}/></button>}
            </div>
          </div>
        </div>
      </article>)}
    </div> : <Empty title="No active workspaces" description="Create a workspace or show archived workspaces to restore one." action={<button className="button button-accent" onClick={() => edit('new')}>Create workspace</button>}/>}
    {editing && <Dialog title={editing === 'new' ? 'Create a workspace' : 'Rename workspace'} onClose={() => setEditing(null)}>
      <form onSubmit={save}>
        <label className="field">Workspace name<input value={name} onChange={event => setName(event.target.value)} required maxLength={80} placeholder="Workspace name"/></label>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button>
          <SubmitButton busy={busy}>{editing === 'new' ? 'Create workspace' : 'Save name'}</SubmitButton>
        </div>
      </form>
    </Dialog>}
    {archiving && <Dialog title="Archive this workspace?" onClose={() => setArchiving(null)}>
      <p className="dialog-copy"><strong>{archiving.name}</strong> will be hidden from the workspace switcher. Your creators, saved research, and notes will be preserved. You can restore it anytime.</p>
      <div className="dialog-actions">
        <button className="button button-secondary" onClick={() => setArchiving(null)}>Keep workspace</button>
        <SubmitButton busy={busy} onClick={() => archive(archiving, true)}>Archive workspace</SubmitButton>
      </div>
    </Dialog>}
  </>;
}
