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
        <a
          href="/app/features/{feature.id}"
          class="block px-6 py-4 hover:bg-slate-50 transition-colors"
        >
          <div class="flex items-center justify-between">
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-medium text-slate-900 truncate">{feature.title}</h3>
              <p class="mt-1 text-xs text-slate-400">{formatDate(feature.created_at)}</p>
            </div>
            <span class="ml-4 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium {statusClasses(feature.status)}">
              {#if isGenerating(feature.status)}
                <span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
              {/if}
              {statusLabel(feature.status)}
            </span>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</div>
