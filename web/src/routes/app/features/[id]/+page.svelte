<script lang="ts">
  import { page } from '$app/state';
  import { apiFetch } from '$lib/api';

  let { data } = $props();

  interface Feature {
    id: string;
    title: string;
    status: string;
    briefMarkdown: string | null;
    specMarkdown: string | null;
    planMarkdown: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
  }

  let feature: Feature | null = $state(null);
  let loading = $state(true);
  let error = $state('');
  let approving = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = $state(null);

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

  async function loadFeature() {
    const featureId = page.params.id;
    const result = await apiFetch<{ feature: Feature }>(`/api/features/${featureId}`, getToken());

    if (result.error) {
      error = result.error;
      loading = false;
      return;
    }

    if (result.data) {
      feature = result.data.feature;
      // If status changed away from generating, stop polling
      if (feature && !isGenerating(feature.status) && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
    loading = false;
  }

  // Load feature on mount and set up polling
  $effect(() => {
    loadFeature();

    return () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  });

  // Start/stop polling based on status
  $effect(() => {
    if (feature && isGenerating(feature.status) && !pollTimer) {
      pollTimer = setInterval(() => {
        loadFeature();
      }, 3000);
    }
  });

  async function approveSpec() {
    if (!feature) return;
    approving = true;
    error = '';

    const result = await apiFetch<{ success: boolean }>(
      `/api/features/${feature.id}/approve-spec`,
      getToken(),
      { method: 'POST' },
    );

    if (result.error) {
      error = result.error;
    } else {
      // Reload to get updated status
      await loadFeature();
    }
    approving = false;
  }

  async function approvePlan() {
    if (!feature) return;
    approving = true;
    error = '';

    const result = await apiFetch<{ success: boolean }>(
      `/api/features/${feature.id}/approve-plan`,
      getToken(),
      { method: 'POST' },
    );

    if (result.error) {
      error = result.error;
    } else {
      await loadFeature();
    }
    approving = false;
  }
</script>

<svelte:head>
  <title>{feature?.title ?? 'Feature'} | Build Practical</title>
</svelte:head>

<div>
  <!-- Back link -->
  <a href="/app" class="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-6 transition-colors">
    &larr; Back to dashboard
  </a>

  {#if error}
    <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="bg-white rounded-xl border border-slate-200 p-12 text-center">
      <p class="text-sm text-slate-400">Loading feature...</p>
    </div>
  {:else if !feature}
    <div class="bg-white rounded-xl border border-slate-200 p-12 text-center">
      <h2 class="text-lg font-semibold text-slate-900">Feature not found</h2>
      <p class="mt-2 text-sm text-slate-500">This feature may have been deleted or you don't have access.</p>
    </div>
  {:else}
    <!-- Header -->
    <div class="flex items-start justify-between mb-6">
      <h1 class="text-2xl font-bold text-slate-900">{feature.title}</h1>
      <span class="ml-4 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium {statusClasses(feature.status)}">
        {#if isGenerating(feature.status)}
          <span class="w-2 h-2 rounded-full bg-current animate-pulse"></span>
        {/if}
        {statusLabel(feature.status)}
      </span>
    </div>

    <!-- Status-specific content -->
    {#if feature.status === 'drafting'}
      <div class="bg-white rounded-xl border border-slate-200 p-8 text-center">
        <p class="text-sm text-slate-600">This feature is still being drafted.</p>
        <a
          href="/app/features?feature={feature.id}"
          class="mt-4 inline-block px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
        >
          Continue chatting
        </a>
      </div>

    {:else if feature.status === 'spec_generating'}
      <div class="bg-white rounded-xl border border-slate-200 p-8 text-center">
        <div class="inline-flex items-center gap-3 text-amber-700">
          <svg class="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p class="text-sm font-medium">Generating specification...</p>
        </div>
        <p class="mt-3 text-xs text-slate-400">This usually takes 30-60 seconds.</p>
      </div>

    {:else if feature.status === 'spec_ready'}
      <!-- Spec display + approve button -->
      <div class="space-y-4">
        <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p class="text-sm text-blue-800 font-medium">Specification ready for review</p>
          <p class="mt-1 text-sm text-blue-700">Review the specification below, then approve to generate the implementation plan.</p>
        </div>

        <div class="bg-white rounded-xl border border-slate-200 p-6">
          <div class="prose prose-sm prose-slate max-w-none whitespace-pre-wrap text-sm text-slate-700 leading-relaxed">
            {feature.specMarkdown}
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button
            onclick={approveSpec}
            disabled={approving}
            class="px-5 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {approving ? 'Generating plan...' : 'Approve specification'}
          </button>
          <a
            href="/app/features?feature={feature.id}"
            class="px-5 py-2.5 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Back to chat
          </a>
        </div>
      </div>

    {:else if feature.status === 'spec_approved' || feature.status === 'plan_generating'}
      <div class="space-y-4">
        {#if feature.specMarkdown}
          <details class="bg-white rounded-xl border border-slate-200">
            <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
              View specification
            </summary>
            <div class="px-6 pb-6 border-t border-slate-200 pt-4">
              <div class="prose prose-sm prose-slate max-w-none whitespace-pre-wrap text-sm text-slate-700 leading-relaxed">
                {feature.specMarkdown}
              </div>
            </div>
          </details>
        {/if}

        <div class="bg-white rounded-xl border border-slate-200 p-8 text-center">
          <div class="inline-flex items-center gap-3 text-amber-700">
            <svg class="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p class="text-sm font-medium">Generating implementation plan...</p>
          </div>
          <p class="mt-3 text-xs text-slate-400">This usually takes 30-60 seconds.</p>
        </div>
      </div>

    {:else if feature.status === 'plan_ready'}
      <div class="space-y-4">
        {#if feature.specMarkdown}
          <details class="bg-white rounded-xl border border-slate-200">
            <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
              View specification
            </summary>
            <div class="px-6 pb-6 border-t border-slate-200 pt-4">
              <div class="prose prose-sm prose-slate max-w-none whitespace-pre-wrap text-sm text-slate-700 leading-relaxed">
                {feature.specMarkdown}
              </div>
            </div>
          </details>
        {/if}

        <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p class="text-sm text-blue-800 font-medium">Implementation plan ready for review</p>
          <p class="mt-1 text-sm text-blue-700">Review the plan below, then approve to proceed.</p>
        </div>

        <div class="bg-white rounded-xl border border-slate-200 p-6">
          <div class="prose prose-sm prose-slate max-w-none whitespace-pre-wrap text-sm text-slate-700 leading-relaxed">
            {feature.planMarkdown}
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button
            onclick={approvePlan}
            disabled={approving}
            class="px-5 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {approving ? 'Approving...' : 'Approve plan'}
          </button>
        </div>
      </div>

    {:else if feature.status === 'plan_approved'}
      <div class="space-y-4">
        {#if feature.specMarkdown}
          <details class="bg-white rounded-xl border border-slate-200">
            <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
              View specification
            </summary>
            <div class="px-6 pb-6 border-t border-slate-200 pt-4">
              <div class="prose prose-sm prose-slate max-w-none whitespace-pre-wrap text-sm text-slate-700 leading-relaxed">
                {feature.specMarkdown}
              </div>
            </div>
          </details>
        {/if}

        {#if feature.planMarkdown}
          <details class="bg-white rounded-xl border border-slate-200">
            <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
              View implementation plan
            </summary>
            <div class="px-6 pb-6 border-t border-slate-200 pt-4">
              <div class="prose prose-sm prose-slate max-w-none whitespace-pre-wrap text-sm text-slate-700 leading-relaxed">
                {feature.planMarkdown}
              </div>
            </div>
          </details>
        {/if}

        <div class="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
          <p class="text-sm text-green-800 font-medium">Plan approved</p>
          <p class="mt-1 text-sm text-green-700">
            The pipeline will continue with code generation in a future update.
          </p>
          <a
            href="/app"
            class="mt-4 inline-block px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
          >
            Back to dashboard
          </a>
        </div>
      </div>

    {:else if feature.status === 'failed'}
      <div class="space-y-4">
        <div class="bg-red-50 border border-red-200 rounded-lg p-6">
          <p class="text-sm text-red-800 font-medium">Pipeline failed</p>
          {#if feature.errorMessage}
            <p class="mt-2 text-sm text-red-700">{feature.errorMessage}</p>
          {/if}
        </div>

        <div class="flex items-center gap-3">
          <a
            href="/app/features?feature={feature.id}"
            class="px-5 py-2.5 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Back to chat
          </a>
          <a
            href="/app"
            class="px-5 py-2.5 text-sm font-medium text-slate-500 hover:text-slate-700 transition-colors"
          >
            Back to dashboard
          </a>
        </div>
      </div>
    {/if}
  {/if}
</div>
