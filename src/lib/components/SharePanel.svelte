<script lang="ts">
  import { onMount } from 'svelte';
  import type { Pattern } from '@seamer/pattern-model';
  import { collaborationRequest as rawRequest, sharedDocumentFingerprint as fingerprint, type SharedAccount, type SharedDocumentView, type SharedRole, CollaborationClientError } from '$lib/utils/collaborationClient';
  import { CollaborationPause } from '$lib/utils/collaborationPause';
  let { pattern, visible = true, mutationPaused = false, sharedDocumentId, onchange, onload, onrestore, onrolechange, onsharedchange, onclose }: {
    pattern: Pattern; visible?: boolean; onchange: (pattern: Pattern, label?: string) => boolean | void;
    mutationPaused?: boolean; sharedDocumentId?: string | null; onsharedchange?: (id: string | null) => void;
    onload?: (pattern: Pattern) => boolean | void; onrestore?: (pattern: Pattern, label?: string) => void; onrolechange?: (role: SharedRole | null) => void; onclose?: () => void;
  } = $props();
  let available = $state<boolean | null>(null), account = $state<SharedAccount | null>(null);
  let shared = $state<SharedDocumentView | null>(null);
  let documents = $state<{ id: string; name: string; role: SharedRole; revision: number }[]>([]);
  let baseline = $state(''), conflict = $state(false), busy = $state(false), error = $state('');
  let email = $state(''), password = $state(''), name = $state(''), register = $state(false);
  let memberEmail = $state(''), memberRole = $state<'editor' | 'viewer'>('editor'), message = $state('');
  let authReady = false, disposed = false, polling = false, pendingSharedId = '', operationGeneration = 0;
  const pauseGate = new CollaborationPause();
  $effect(() => pauseGate.setPaused(mutationPaused));
  class SupersededOperation extends Error {}
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const generation = operationGeneration, documentId = pattern.id;
    try {
      const value = await rawRequest<T>(path, body);
      pauseGate.setPaused(mutationPaused);
      await pauseGate.wait();
      if (disposed || generation !== operationGeneration || pattern.id !== documentId) throw new SupersededOperation();
      return value;
    } catch (error) { if (disposed || generation !== operationGeneration || pattern.id !== documentId) throw new SupersededOperation(); throw error; }
  }
  let panel = $state<HTMLDivElement | undefined>();
  $effect(() => { if (visible && panel) panel.focus(); });
  function modalKey(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onclose?.(); }
    if (event.key !== 'Tab' || !panel) return;
    const items = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')];
    const first = items[0], last = items.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  async function openPending() { if (pendingSharedId) { const id = pendingSharedId; pendingSharedId = ''; await loadShared(id); } }
  async function loadShared(id: string) { const before = fingerprint(pattern); const value = await request<SharedDocumentView>(`documents/${id}`); if (fingerprint(pattern) !== before) throw new Error('Your document changed while loading. Your draft was preserved; open the shared document again when ready.'); adopt(value); }
  function sharedLink() { if (!shared) return ''; const url = new URL(location.href); url.searchParams.set('shared', shared.id); return url.href; }
  const dirty = $derived(shared !== null && fingerprint(pattern) !== baseline);
  function fail(value: unknown) { if (value instanceof SupersededOperation) return; error = value instanceof Error ? value.message : 'Sharing request failed.'; }
  async function action(fn: () => Promise<void>) { if (busy || mutationPaused) return; busy = true; error = ''; try { await fn(); } catch (e) { fail(e); } finally { busy = false; } }
  async function refreshList() { documents = await request('documents'); }
  function detach() { ++operationGeneration; shared = null; conflict = false; baseline = ''; onrolechange?.(null); onsharedchange?.(null); }
  function adopt(view: SharedDocumentView) {
    const accepted = pattern.id !== view.pattern.id ? (onload ?? onchange)(view.pattern) : onchange(view.pattern, 'Receive shared document');
    if (accepted === false) throw new Error('The workspace cannot receive this revision yet. Sharing will retry when it is ready.');
    ++operationGeneration;
    baseline = fingerprint(view.pattern); shared = view; conflict = false; onrolechange?.(view.role); onsharedchange?.(view.id);
  }
  async function authenticate() { await action(async () => { account = await request(register ? 'register' : 'login', { email, password, name }); password = ''; await refreshList(); await openPending(); }); }
  async function publishNew() { await action(async () => { const before = fingerprint(pattern); const value = await request<SharedDocumentView>('documents', { pattern: $state.snapshot(pattern) }); await refreshList(); if (fingerprint(pattern) !== before) throw new Error('Your document changed while sharing. Your current draft was preserved and the server snapshot appears in Shared documents.'); adopt(value); }); }
  async function open(id: string) { await action(async () => { await loadShared(id); }); }
  async function save() {
    if (!shared || mutationPaused || busy || conflict || shared.role === 'viewer' || !dirty) return;
    await action(async () => {
      const value = await request<SharedDocumentView>(`documents/${shared!.id}`, { revision: shared!.revision, pattern: $state.snapshot(pattern) });
      // The draft may change while this request is in flight; keep those newer local changes dirty.
      baseline = fingerprint(value.pattern); shared = value;
    });
    if (error.includes('shared document changed')) { conflict = true; await poll(); }
  }
  function receive(value: SharedDocumentView) {
    if (!shared) return;
    onrolechange?.(value.role);
    if (value.revision > shared.revision) { if (dirty) { shared = value; conflict = true; } else adopt(value); }
    else shared = { ...shared, members: value.members, messages: value.messages, versions: value.versions, role: value.role, changeToken: value.changeToken };
  }
  async function poll() {
    if (!shared || mutationPaused || polling || busy) return;
    polling = true;
    try {
      const id = shared.id, value = await request<SharedDocumentView | { unchanged: true }>(`documents/${id}?since=${encodeURIComponent(shared.changeToken)}`);
      if (disposed || shared?.id !== id || 'unchanged' in value) return;
      receive(value);
    } catch (e) { fail(e); if (e instanceof CollaborationClientError && [401, 403, 404].includes(e.status)) { if (shared) shared = { ...shared, role: 'viewer' }; onrolechange?.('viewer'); } } finally { polling = false; }
  }
  $effect(() => {
    if (!shared || mutationPaused || !dirty || conflict || shared.role === 'viewer' || busy) return;
    const timer = setTimeout(() => { void save(); }, 900);
    return () => clearTimeout(timer);
  });
  $effect(() => { if (shared && pattern.id !== shared.pattern.id && authReady) detach(); });
  $effect(() => { if (sharedDocumentId === null && (shared || pendingSharedId)) { pendingSharedId = ''; detach(); } });
  onMount(() => {
    disposed = false;
    pendingSharedId = new URL(location.href).searchParams.get('shared') ?? '';
    if (!/^[a-f\d-]{36}$/.test(pendingSharedId)) pendingSharedId = '';
    void (async () => {
      try { await rawRequest('status'); if (disposed) return; available = true;
        try {
          const session = await rawRequest<SharedAccount>('session'); if (disposed) return; account = session;
          await refreshList(); await openPending();
        } catch (error) {
          if (disposed || error instanceof SupersededOperation) return;
          if (error instanceof CollaborationClientError && error.status === 401) account = null;
          else fail(error);
        }
      } catch (error) { if (disposed || error instanceof SupersededOperation) return; available = false; }
      authReady = true;
    })();
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { disposed = true; pauseGate.dispose(); clearInterval(timer); onrolechange?.(null); };
  });
</script>

{#if visible}
<div class="share-backdrop" role="presentation">
  <div bind:this={panel} class="share-panel" role="dialog" tabindex="-1" onkeydown={modalKey} aria-label="Sharing and collaboration" aria-modal="true" data-document-keyboard="true">
    <header><h2>Sharing and collaboration</h2><button class="btn btn-ghost btn-sm" onclick={onclose} aria-label="Close sharing">✕</button></header>
    {#if mutationPaused}<p role="status">Sharing is paused during read-only inspection or document loading. Incoming revisions resume when the workspace is ready.</p>{/if}
    {#if available === null}<p>Checking collaboration server…</p>
    {:else if !available}<p>Sharing is available when Seamer runs with its Node server. This deployment stores documents on this device.</p><p>Run <code>pnpm build:server</code> and start the generated server with <code>SEAMER_DATA_DIR</code> set to a private, persistent directory.</p>
    {:else if !account}
      <form onsubmit={(event) => { event.preventDefault(); void authenticate(); }} class="space-y-3">
        <h3>{register ? 'Create account' : 'Sign in'}</h3>
        {#if register}<label>Name<input class="input input-bordered input-sm" bind:value={name} required maxlength="80" autocomplete="name" /></label>{/if}
        <label>Email<input class="input input-bordered input-sm" type="email" bind:value={email} required autocomplete="email" /></label>
        <label>Password<input class="input input-bordered input-sm" type="password" bind:value={password} required minlength={register ? 12 : 1} maxlength="256" autocomplete={register ? 'new-password' : 'current-password'} /></label>
        <button class="btn btn-primary btn-sm" disabled={busy}>{register ? 'Create account' : 'Sign in'}</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => { register = !register; error = ''; }}>{register ? 'Already have an account' : 'Create an account'}</button>
      </form>
    {:else}
      <p>Signed in as <strong>{account.name}</strong> ({account.email})</p>
      <button class="btn btn-ghost btn-xs" disabled={busy} onclick={() => action(async () => { await request('logout', {}); account = null; documents = []; detach(); })}>Sign out</button>
      {#if !shared}
        <p>Publish this document to the server, then grant access to registered collaborators.</p>
        <button class="btn btn-primary btn-sm" disabled={busy} onclick={publishNew}>Share current document</button>
      {:else}
        <h3>{shared.pattern.name}</h3><p class="text-sm">{shared.role} · revision {shared.revision} · {conflict ? 'Conflicting changes' : dirty ? 'Saving changes…' : 'All changes shared'}</p>
        <p class="text-xs">Document ID: <code>{shared.id}</code></p><button class="btn btn-ghost btn-xs" onclick={() => action(async () => { await navigator.clipboard.writeText(sharedLink()); })}>Copy shared link</button>
        {#if conflict}<div role="alert" class="alert alert-warning"><div><p>Your draft and the server both changed. Your draft is preserved.</p><button class="btn btn-xs" onclick={() => open(shared!.id)}>Load server version</button><button class="btn btn-xs" onclick={publishNew}>Share draft as a new document</button></div></div>{/if}
        <button class="btn btn-ghost btn-xs" onclick={detach}>Continue as local document</button>
        <h3>Access</h3>
        {#each shared.members as member}<div class="member"><span>{member.name} · {member.email} · {member.role}</span>{#if shared.role === 'owner' && member.role !== 'owner'}<button class="btn btn-ghost btn-xs" disabled={busy} onclick={() => action(async () => { receive(await request(`members/${shared!.id}`, { email: member.email, role: 'remove' })); })}>Remove</button>{/if}</div>{/each}
        {#if shared.role === 'owner'}<form class="row" onsubmit={(event) => { event.preventDefault(); action(async () => { receive(await request(`members/${shared!.id}`, { email: memberEmail, role: memberRole })); memberEmail = ''; }); }}>
          <input class="input input-bordered input-sm" type="email" bind:value={memberEmail} placeholder="Registered email" aria-label="Collaborator email" required />
          <select class="select select-bordered select-sm" bind:value={memberRole} aria-label="Collaborator role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button class="btn btn-sm" disabled={busy}>Grant access</button>
        </form>{/if}
        <h3>Chat</h3><div class="messages" aria-live="polite">{#each shared.messages as item (item.id)}<p><strong>{item.author}</strong> <time>{new Date(item.sentAt).toLocaleTimeString()}</time><br />{item.text}</p>{/each}{#if !shared.messages.length}<p>No messages yet.</p>{/if}</div>
        <form class="row" onsubmit={(event) => { event.preventDefault(); action(async () => { receive(await request(`chat/${shared!.id}`, { text: message })); message = ''; }); }}><input class="input input-bordered input-sm" bind:value={message} placeholder="Message collaborators" aria-label="Chat message" maxlength="2000" required /><button class="btn btn-primary btn-sm" disabled={busy}>Send</button></form>
        <h3>Server version history</h3>{#each [...shared.versions].reverse() as version}<div class="member"><span>Revision {version.revision} · {version.author} · {new Date(version.savedAt).toLocaleString()}</span>{#if shared.role !== 'viewer' && version.revision !== shared.revision}<button class="btn btn-xs" disabled={busy || conflict} onclick={() => action(async () => { const before = fingerprint(pattern); const value = await request<{ pattern: Pattern }>(`versions/${shared!.id}?revision=${version.revision}`); if (fingerprint(pattern) !== before) throw new Error('Your draft changed while loading the version. Restore it again when ready.'); (onrestore ?? onchange)(value.pattern, 'Restore shared version'); })}>Restore</button>{/if}</div>{/each}
      {/if}
      <h3>Shared documents</h3>{#each documents as document}<button class="document btn btn-ghost btn-sm" disabled={busy} onclick={() => open(document.id)}>{document.name} · {document.role}</button>{/each}
      <button class="btn btn-ghost btn-xs" disabled={busy} onclick={() => action(refreshList)}>Refresh shared documents</button>
    {/if}
    {#if error}<p role="alert" class="text-error">{error}</p>{/if}
  </div>
</div>
{/if}
<style>
  .share-backdrop{position:fixed;inset:0;z-index:210;display:flex;justify-content:flex-end;background:#0005}.share-panel{width:min(600px,100%);height:100%;overflow:auto;background:var(--color-base-100,#fff);padding:1rem;color:var(--color-base-content,#111)}header,.row,.member{display:flex;gap:.5rem;align-items:center;justify-content:space-between}header h2{font-size:1.2rem;font-weight:700}h3{font-weight:650;margin-top:1.2rem;margin-bottom:.5rem}p{margin:.5rem 0}label{display:flex;flex-direction:column;gap:.2rem}.row input{flex:1;min-width:0}.messages{max-height:240px;overflow:auto;background:var(--color-base-200,#eee);padding:.6rem;border-radius:.3rem}.messages time{font-size:.7rem;color:var(--color-base-content,#555)}.member{font-size:.75rem;margin:.4rem 0}.document{display:block;width:100%;text-align:left}code{word-break:break-all;font-size:.8rem}
</style>
