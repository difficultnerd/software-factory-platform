<script lang="ts">
  import { apiFetch } from '$lib/api';

  let { data } = $props();

  interface Feature {
    id: string;
    title: string;
    status: string;
    created_at: string;
    updated_at: string;
  }

  let features: Feature[] = $state([]);
  let loading = $state(true);
  let error = $state('');

  function getToken(): string {
    return data.session?.access_token ?? '';
  }

  function statusLabel(status: string): string {
    const labels: Record<string, string> = {
      drafting: 'Drafting',
      spec_generating: 'Generating spec',
      spec_ready: 'Spec ready',
      spec_approved: 'Spec approved',
      plan_generating: 'Generating plan',
      plan_ready: 'Plan ready',
      plan_approved: 'Plan approved',
      failed: 'Failed',
      done: 'Done',
    };
    return labels[status] ?? status;
  }

  function statusClasses(status: string): string {
    if (status === 'failed') return 'bg-red-100 text-red-700';
    if (status === 'done' || status === 'plan_approved') return 'bg-green-100 text-green-700';
    if (status.endsWith('_generating')) return 'bg-amber-100 text-amber-700';
    if (status.endsWith('_ready')) return 'bg-blue-100 text-blue-700';
    if (status.endsWith('_approved')) return 'bg-green-100 text-green-700';
    if (status === 'drafting') return 'bg-slate-100 text-slate-600';
    return 'bg-slate-100 text-slate-600';
  }

  function isGenerating(status: string): boolean {
    return status.endsWith('_generating');
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  let editingId: string | null = $state(null);
  let editTitle = $state('');
  let deleting = $state('');

  $effect(() => {
    loadFeatures();
  });

  async function loadFeatures() {
    loading = true;
    error = '';

    const result = await apiFetch<{ features: Feature[] }>('/api/features', getToken());

    if (result.error) {
      error = result.error;
    } else if (result.data) {
      features = result.data.features;
    }
    loading = false;
  }

  function startEditing(feature: Feature) {
    editingId = feature.id;
    editTitle = feature.title;
  }

  function cancelEditing() {
    editingId = null;
    editTitle = '';
  }

  async function saveTitle(featureId: string) {
    const trimmed = editTitle.trim();
    if (!trimmed) return;

    const result = await apiFetch<{ id: string; title: string }>(
      `/api/features/${featureId}`,
      getToken(),
      { method: 'PATCH', body: { title: trimmed } },
    );

    if (result.error) {
      error = result.error;
    } else {
      const idx = features.findIndex((f) => f.id === featureId);
      if (idx !== -1 && result.data) {
        features[idx].title = result.data.title;
      }
    }
    editingId = null;
    editTitle = '';
  }

  function handleTitleKeydown(e: KeyboardEvent, featureId: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTitle(featureId);
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  }

  async function deleteFeature(featureId: string) {
    if (!confirm('Are you sure you want to delete this feature? This cannot be undone.')) return;

    deleting = featureId;
    const result = await apiFetch<{ success: boolean }>(
      `/api/features/${featureId}`,
      getToken(),
      { method: 'DELETE' },
    );

    if (result.error) {
      error = result.error;
    } else {
      features = features.filter((f) => f.id !== featureId);
    }
    deleting = '';
  }
</script>

<svelte:head>
  <title>Dashboard | Build Practical</title>
</svelte:head>

<div>
  <div class="flex items-center justify-between mb-8">
    <div>
      <h1 class="text-2xl font-bold text-slate-900">Dashboard</h1>
      <p class="mt-1 text-sm text-slate-500">Your features and projects</p>
    </div>
    <a
      href="/app/features"
      class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
    >
      New feature
    </a>
  </div>

  {#if error}
    <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="bg-white rounded-xl border border-slate-200 p-12 text-center">
      <p class="text-sm text-slate-400">Loading features...</p>
    </div>
  {:else if features.length === 0}
    <!-- Empty state -->
    <div class="bg-white rounded-xl border border-slate-200 p-12 text-center">
      <h2 class="text-lg font-semibold text-slate-900">No features yet</h2>
      <p class="mt-2 text-sm text-slate-500 max-w-md mx-auto">
        Describe what you want to build, and our AI agents will handle the rest:
        spec, tests, implementation, and security review.
      </p>
      <p class="mt-4 text-sm text-slate-400">
        First, add your Anthropic API key in <a href="/app/settings" class="text-brand-600 hover:text-brand-700">Settings</a>.
      </p>
    </div>
  {:else}
    <!-- Feature list -->
    <div class="bg-white rounded-xl border border-slate-200 divide-y divide-slate-200">
      {#each features as feature}
        <div class="flex items-center px-6 py-4 hover:bg-slate-50 transition-colors gap-3">
          <a href="/app/features/{feature.id}" class="min-w-0 flex-1">
            {#if editingId === feature.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                type="text"
                bind:value={editTitle}
                onkeydown={(e) => handleTitleKeydown(e, feature.id)}
                onblur={() => saveTitle(feature.id)}
                autofocus
                onclick={(e) => e.preventDefault()}
                class="w-full text-sm font-medium text-slate-900 border border-brand-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            {:else}
              <h3 class="text-sm font-medium text-slate-900 truncate">{feature.title}</h3>
            {/if}
            <p class="mt-1 text-xs text-slate-400">{formatDate(feature.created_at)}</p>
          </a>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap {statusClasses(feature.status)}">
            {#if isGenerating(feature.status)}
              <span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
            {/if}
            {statusLabel(feature.status)}
          </span>
          <button
            type="button"
            onclick={(e) => { e.preventDefault(); e.stopPropagation(); startEditing(feature); }}
            class="p-1.5 text-slate-400 hover:text-slate-600 transition-colors"
            title="Rename"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button
            type="button"
            onclick={(e) => { e.preventDefault(); e.stopPropagation(); deleteFeature(feature.id); }}
            disabled={deleting === feature.id}
            class="p-1.5 text-slate-400 hover:text-red-600 transition-colors disabled:opacity-50"
            title="Delete"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>
