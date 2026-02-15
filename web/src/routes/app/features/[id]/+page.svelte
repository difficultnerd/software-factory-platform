<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { apiFetch } from '$lib/api';
  import { PUBLIC_API_URL } from '$env/static/public';
  import { marked } from 'marked';

  let { data } = $props();

  interface Feature {
    id: string;
    title: string;
    status: string;
    briefMarkdown: string | null;
    specMarkdown: string | null;
    planMarkdown: string | null;
    testsMarkdown: string | null;
    securityReviewMarkdown: string | null;
    codeReviewMarkdown: string | null;
    specRecommendation: string | null;
    planRecommendation: string | null;
    testsRecommendation: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
  }

  let feature: Feature | null = $state(null);
  let loading = $state(true);
  let error = $state('');
  let approving = $state(false);
  let retrying = $state(false);
  let deletingFeature = $state(false);
  let downloading = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = $state(null);

  // Configure marked for safe defaults
  marked.setOptions({ breaks: true, gfm: true });

  function renderMarkdown(content: string): string {
    return marked.parse(content) as string;
  }

  function getToken(): string {
    return data.session?.access_token ?? '';
  }

  function statusLabel(status: string): string {
    const labels: Record<string, string> = {
      drafting: 'Drafting',
      spec_generating: 'Generating spec',
      spec_ready: 'Spec ready',
      plan_generating: 'Generating plan',
      plan_ready: 'Plan ready',
      tests_generating: 'Generating tests',
      tests_ready: 'Tests ready',
      implementing: 'Implementing',
      review: 'Reviewing',
      failed: 'Failed',
      done: 'Done',
    };
    return labels[status] ?? status;
  }

  function statusClasses(status: string): string {
    if (status === 'failed') return 'bg-red-100 text-red-700';
    if (status === 'done') return 'bg-green-100 text-green-700';
    if (status === 'implementing' || status === 'review') return 'bg-amber-100 text-amber-700';
    if (status.endsWith('_generating')) return 'bg-amber-100 text-amber-700';
    if (status.endsWith('_ready')) return 'bg-blue-100 text-blue-700';
    if (status === 'drafting') return 'bg-slate-100 text-slate-600';
    return 'bg-slate-100 text-slate-600';
  }

  function isProcessing(status: string): boolean {
    return status.endsWith('_generating') || status === 'implementing' || status === 'review';
  }

  // Pipeline breadcrumb steps
  interface PipelineStep {
    label: string;
    state: 'completed' | 'active' | 'pending' | 'failed';
  }

  let pipelineSteps = $derived.by((): PipelineStep[] => {
    if (!feature) return [];
    const s = feature.status;
    const failed = s === 'failed';

    function stepState(completedWhen: boolean, activeStatuses: string[]): PipelineStep['state'] {
      if (completedWhen && !activeStatuses.includes(s)) return 'completed';
      if (activeStatuses.includes(s)) return failed ? 'failed' : 'active';
      if (failed && !completedWhen) return 'failed';
      return 'pending';
    }

    return [
      {
        label: 'Brief',
        state: stepState(!!feature.briefMarkdown, ['drafting']),
      },
      {
        label: 'Specification',
        state: stepState(!!feature.specMarkdown, ['spec_generating', 'spec_ready']),
      },
      {
        label: 'Plan',
        state: stepState(!!feature.planMarkdown, ['plan_generating', 'plan_ready']),
      },
      {
        label: 'Tests',
        state: stepState(!!feature.testsMarkdown, ['tests_generating', 'tests_ready']),
      },
      {
        label: 'Code',
        state: stepState(
          s === 'review' || s === 'done' || (failed && !!feature.securityReviewMarkdown),
          ['implementing'],
        ),
      },
      {
        label: 'Review',
        state: stepState(s === 'done', ['review']),
      },
    ];
  });

  // Determine which deliverables to show as collapsible sections
  const statusOrder = ['drafting', 'spec_generating', 'spec_ready', 'plan_generating', 'plan_ready', 'tests_generating', 'tests_ready', 'implementing', 'review', 'done', 'failed'];

  function isPast(current: string, threshold: string): boolean {
    const ci = statusOrder.indexOf(current);
    const ti = statusOrder.indexOf(threshold);
    if (ci === -1 || ti === -1) return false;
    // For failed status, show all available deliverables
    if (current === 'failed') return true;
    return ci > ti;
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
      // If status changed away from processing, stop polling
      if (feature && !isProcessing(feature.status) && pollTimer) {
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
    if (feature && isProcessing(feature.status) && !pollTimer) {
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

  async function approveTests() {
    if (!feature) return;
    approving = true;
    error = '';

    const result = await apiFetch<{ success: boolean }>(
      `/api/features/${feature.id}/approve-tests`,
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

  async function downloadCode() {
    if (!feature) return;
    downloading = true;
    error = '';

    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/features/${feature.id}/download`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        error = body.error ?? 'Download failed';
        downloading = false;
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Extract filename from Content-Disposition or fall back
      const disposition = res.headers.get('Content-Disposition');
      const match = disposition?.match(/filename="(.+)"/);
      a.download = match?.[1] ?? 'feature.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      error = 'Network error during download. Please try again.';
    }
    downloading = false;
  }

  async function deleteFeature() {
    if (!feature) return;
    if (!confirm('Are you sure you want to delete this feature? This cannot be undone.')) return;

    deletingFeature = true;
    error = '';

    const result = await apiFetch<{ success: boolean }>(
      `/api/features/${feature.id}`,
      getToken(),
      { method: 'DELETE' },
    );

    if (result.error) {
      error = result.error;
      deletingFeature = false;
    } else {
      goto('/app');
    }
  }

  function parseRecommendationVerdict(recommendation: string | null): 'APPROVE' | 'REVISE' | null {
    if (!recommendation) return null;
    const lines = recommendation.trim().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const line = lines[i]?.trim();
      if (line === 'VERDICT: APPROVE') return 'APPROVE';
      if (line === 'VERDICT: REVISE') return 'REVISE';
    }
    return null;
  }

  async function retryFeature() {
    if (!feature) return;
    retrying = true;
    error = '';

    const result = await apiFetch<{ success: boolean; targetStatus: string }>(
      `/api/features/${feature.id}/retry`,
      getToken(),
      { method: 'POST' },
    );

    if (result.error) {
      error = result.error;
    } else {
      await loadFeature();
    }
    retrying = false;
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
      <div class="flex items-center gap-3 ml-4">
        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium {statusClasses(feature.status)}">
          {#if isProcessing(feature.status)}
            <span class="w-2 h-2 rounded-full bg-current animate-pulse"></span>
          {/if}
          {statusLabel(feature.status)}
        </span>
        <button
          type="button"
          onclick={deleteFeature}
          disabled={deletingFeature}
          class="px-3 py-1.5 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {deletingFeature ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </div>

    <!-- Breadcrumb trail -->
    {#if feature.status !== 'drafting'}
      <nav class="mb-6 bg-white rounded-xl border border-slate-200 px-6 py-4">
        <ol class="flex items-center gap-0">
          {#each pipelineSteps as step, i}
            <li class="flex items-center {i < pipelineSteps.length - 1 ? 'flex-1' : ''}">
              <div class="flex flex-col items-center gap-1">
                <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold
                  {step.state === 'completed' ? 'bg-green-500 text-white' :
                   step.state === 'active' ? 'bg-brand-600 text-white' :
                   step.state === 'failed' ? 'bg-red-500 text-white' :
                   'bg-slate-200 text-slate-500'}">
                  {#if step.state === 'completed'}
                    <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  {:else if step.state === 'failed'}
                    <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  {:else}
                    {i + 1}
                  {/if}
                </div>
                <span class="text-xs font-medium
                  {step.state === 'completed' ? 'text-green-700' :
                   step.state === 'active' ? 'text-brand-700' :
                   step.state === 'failed' ? 'text-red-700' :
                   'text-slate-400'}">
                  {step.label}
                </span>
              </div>
              {#if i < pipelineSteps.length - 1}
                <div class="flex-1 h-0.5 mx-2 mt-[-1rem]
                  {pipelineSteps[i + 1].state === 'completed' || pipelineSteps[i + 1].state === 'active' ? 'bg-green-300' :
                   pipelineSteps[i + 1].state === 'failed' ? 'bg-red-300' :
                   'bg-slate-200'}">
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      </nav>
    {/if}

    <!-- Previous deliverables (collapsible) -->
    <div class="space-y-2 mb-4">
      {#if feature.briefMarkdown && isPast(feature.status, 'drafting')}
        <details class="bg-white rounded-xl border border-slate-200">
          <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
            View brief
          </summary>
          <div class="px-6 pb-6 border-t border-slate-200 pt-4">
            <div class="prose prose-sm prose-slate max-w-none">
              {@html renderMarkdown(feature.briefMarkdown)}
            </div>
          </div>
        </details>
      {/if}

      {#if feature.specMarkdown && isPast(feature.status, 'spec_ready')}
        <details class="bg-white rounded-xl border border-slate-200">
          <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
            View specification
          </summary>
          <div class="px-6 pb-6 border-t border-slate-200 pt-4">
            <div class="prose prose-sm prose-slate max-w-none">
              {@html renderMarkdown(feature.specMarkdown)}
            </div>
          </div>
        </details>
      {/if}

      {#if feature.planMarkdown && isPast(feature.status, 'plan_ready')}
        <details class="bg-white rounded-xl border border-slate-200">
          <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
            View implementation plan
          </summary>
          <div class="px-6 pb-6 border-t border-slate-200 pt-4">
            <div class="prose prose-sm prose-slate max-w-none">
              {@html renderMarkdown(feature.planMarkdown)}
            </div>
          </div>
        </details>
      {/if}

      {#if feature.testsMarkdown && isPast(feature.status, 'tests_ready')}
        <details class="bg-white rounded-xl border border-slate-200">
          <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
            View test contracts
          </summary>
          <div class="px-6 pb-6 border-t border-slate-200 pt-4">
            <div class="prose prose-sm prose-slate max-w-none">
              {@html renderMarkdown(feature.testsMarkdown)}
            </div>
          </div>
        </details>
      {/if}

      {#if feature.securityReviewMarkdown}
        <details class="bg-white rounded-xl border border-slate-200">
          <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
            View security review
          </summary>
          <div class="px-6 pb-6 border-t border-slate-200 pt-4">
            <div class="prose prose-sm prose-slate max-w-none">
              {@html renderMarkdown(feature.securityReviewMarkdown)}
            </div>
          </div>
        </details>
      {/if}

      {#if feature.codeReviewMarkdown}
        <details class="bg-white rounded-xl border border-slate-200">
          <summary class="px-6 py-4 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
            View code review
          </summary>
          <div class="px-6 pb-6 border-t border-slate-200 pt-4">
            <div class="prose prose-sm prose-slate max-w-none">
              {@html renderMarkdown(feature.codeReviewMarkdown)}
            </div>
          </div>
        </details>
      {/if}
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
      {@const specVerdict = parseRecommendationVerdict(feature.specRecommendation)}
      <div class="space-y-4">
        {#if feature.specRecommendation}
          <div class="rounded-lg p-4 {specVerdict === 'APPROVE' ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}">
            <p class="text-sm font-medium {specVerdict === 'APPROVE' ? 'text-green-800' : 'text-amber-800'}">
              {specVerdict === 'APPROVE' ? 'Alignment review: Approved' : 'Alignment review: Revision recommended'}
            </p>
            <div class="mt-2 prose prose-sm max-w-none {specVerdict === 'APPROVE' ? 'prose-green' : 'prose-amber'}">
              {@html renderMarkdown(feature.specRecommendation)}
            </div>
          </div>
        {:else}
          <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p class="text-sm text-blue-800 font-medium">Specification ready for review</p>
            <p class="mt-1 text-sm text-blue-700">Review the specification below, then approve to generate the implementation plan.</p>
          </div>
        {/if}

        <div class="bg-white rounded-xl border border-slate-200 p-6">
          <div class="prose prose-sm prose-slate max-w-none">
            {@html renderMarkdown(feature.specMarkdown ?? '')}
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button
            onclick={approveSpec}
            disabled={approving}
            class="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed {specVerdict === 'REVISE' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-brand-600 hover:bg-brand-700'}"
          >
            {approving ? 'Generating plan...' : specVerdict === 'REVISE' ? 'Approve anyway' : 'Approve specification'}
          </button>
          <a
            href="/app/features?feature={feature.id}"
            class="px-5 py-2.5 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Discuss with BA
          </a>
        </div>
      </div>

    {:else if feature.status === 'plan_generating'}
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

    {:else if feature.status === 'plan_ready'}
      {@const planVerdict = parseRecommendationVerdict(feature.planRecommendation)}
      <div class="space-y-4">
        {#if feature.planRecommendation}
          <div class="rounded-lg p-4 {planVerdict === 'APPROVE' ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}">
            <p class="text-sm font-medium {planVerdict === 'APPROVE' ? 'text-green-800' : 'text-amber-800'}">
              {planVerdict === 'APPROVE' ? 'Alignment review: Approved' : 'Alignment review: Revision recommended'}
            </p>
            <div class="mt-2 prose prose-sm max-w-none {planVerdict === 'APPROVE' ? 'prose-green' : 'prose-amber'}">
              {@html renderMarkdown(feature.planRecommendation)}
            </div>
          </div>
        {:else}
          <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p class="text-sm text-blue-800 font-medium">Implementation plan ready for review</p>
            <p class="mt-1 text-sm text-blue-700">Review the plan below, then approve to generate test contracts.</p>
          </div>
        {/if}

        <div class="bg-white rounded-xl border border-slate-200 p-6">
          <div class="prose prose-sm prose-slate max-w-none">
            {@html renderMarkdown(feature.planMarkdown ?? '')}
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button
            onclick={approvePlan}
            disabled={approving}
            class="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed {planVerdict === 'REVISE' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-brand-600 hover:bg-brand-700'}"
          >
            {approving ? 'Generating tests...' : planVerdict === 'REVISE' ? 'Approve anyway' : 'Approve plan'}
          </button>
          <a
            href="/app/features?feature={feature.id}"
            class="px-5 py-2.5 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Discuss with BA
          </a>
        </div>
      </div>

    {:else if feature.status === 'tests_generating'}
      <div class="bg-white rounded-xl border border-slate-200 p-8 text-center">
        <div class="inline-flex items-center gap-3 text-amber-700">
          <svg class="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p class="text-sm font-medium">Generating test contracts...</p>
        </div>
        <p class="mt-3 text-xs text-slate-400">This usually takes 30-60 seconds.</p>
      </div>

    {:else if feature.status === 'tests_ready'}
      {@const testsVerdict = parseRecommendationVerdict(feature.testsRecommendation)}
      <div class="space-y-4">
        {#if feature.testsRecommendation}
          <div class="rounded-lg p-4 {testsVerdict === 'APPROVE' ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}">
            <p class="text-sm font-medium {testsVerdict === 'APPROVE' ? 'text-green-800' : 'text-amber-800'}">
              {testsVerdict === 'APPROVE' ? 'Alignment review: Approved' : 'Alignment review: Revision recommended'}
            </p>
            <div class="mt-2 prose prose-sm max-w-none {testsVerdict === 'APPROVE' ? 'prose-green' : 'prose-amber'}">
              {@html renderMarkdown(feature.testsRecommendation)}
            </div>
          </div>
        {:else}
          <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p class="text-sm text-blue-800 font-medium">Test contracts ready for review</p>
            <p class="mt-1 text-sm text-blue-700">Review the test contracts below, then approve to begin code generation and automated review.</p>
          </div>
        {/if}

        <div class="bg-white rounded-xl border border-slate-200 p-6">
          <div class="prose prose-sm prose-slate max-w-none">
            {@html renderMarkdown(feature.testsMarkdown ?? '')}
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button
            onclick={approveTests}
            disabled={approving}
            class="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed {testsVerdict === 'REVISE' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-brand-600 hover:bg-brand-700'}"
          >
            {approving ? 'Generating code...' : testsVerdict === 'REVISE' ? 'Approve anyway' : 'Approve tests'}
          </button>
          <a
            href="/app/features?feature={feature.id}"
            class="px-5 py-2.5 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Discuss with BA
          </a>
        </div>
      </div>

    {:else if feature.status === 'implementing'}
      <div class="bg-white rounded-xl border border-slate-200 p-8 text-center">
        <div class="inline-flex items-center gap-3 text-amber-700">
          <svg class="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p class="text-sm font-medium">Generating code...</p>
        </div>
        <p class="mt-3 text-xs text-slate-400">This usually takes 60-90 seconds.</p>
      </div>

    {:else if feature.status === 'review'}
      <div class="bg-white rounded-xl border border-slate-200 p-8 text-center">
        <div class="inline-flex items-center gap-3 text-amber-700">
          <svg class="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p class="text-sm font-medium">Running security and code review...</p>
        </div>
        <p class="mt-3 text-xs text-slate-400">This usually takes 30-60 seconds.</p>
      </div>

    {:else if feature.status === 'done'}
      <div class="space-y-4">
        {#if feature.errorMessage}
          <div class="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p class="text-sm text-amber-800 font-medium">Partial result</p>
            <p class="mt-1 text-sm text-amber-700">{feature.errorMessage}</p>
          </div>
        {/if}

        <div class="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
          <p class="text-sm text-green-800 font-medium">Code generated successfully</p>
          <p class="mt-1 text-sm text-green-700">
            Your code has passed security and code review. Download it as a zip file.
          </p>
          <button
            onclick={downloadCode}
            disabled={downloading}
            class="mt-4 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {#if downloading}
              <svg class="w-4 h-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Downloading...
            {:else}
              <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download code
            {/if}
          </button>
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
          <button
            onclick={retryFeature}
            disabled={retrying}
            class="px-5 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {retrying ? 'Retrying...' : 'Retry from last checkpoint'}
          </button>
          <a
            href="/app/features?feature={feature.id}"
            class="px-5 py-2.5 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Discuss with BA
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
