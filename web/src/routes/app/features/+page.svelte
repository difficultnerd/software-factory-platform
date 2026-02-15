<script lang="ts">
  import { page } from '$app/state';
  import { apiFetch } from '$lib/api';
  import { parseSSE } from '$lib/sse';
  import { PUBLIC_API_URL } from '$env/static/public';

  let { data } = $props();

  interface Message {
    role: 'user' | 'assistant';
    content: string;
  }

  let messages: Message[] = $state([]);
  let input = $state('');
  let streaming = $state(false);
  let featureId: string | null = $state(null);
  let error = $state('');
  let streamingContent = $state('');
  let featureStatus: string | null = $state(null);
  let confirming = $state(false);
  let confirmed = $state(false);
  let revising = $state(false);
  let loadingHistory = $state(false);

  let canSend = $derived(input.trim().length > 0 && !streaming);
  let briefDetected = $derived(
    messages.some((m) => m.role === 'assistant' && m.content.includes('## Brief')),
  );

  let messagesContainer: HTMLDivElement | undefined = $state(undefined);

  function getToken(): string {
    return data.session?.access_token ?? '';
  }

  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  // Auto-scroll when messages change or streaming content updates
  $effect(() => {
    // Touch reactive values to subscribe
    messages.length;
    streamingContent;
    // Use queueMicrotask so DOM has updated
    queueMicrotask(scrollToBottom);
  });

  // Load history from URL param on mount
  $effect(() => {
    const featureParam = page.url.searchParams.get('feature');
    if (featureParam) {
      featureId = featureParam;
      loadHistory(featureParam);
    }
  });

  async function loadHistory(id: string) {
    loadingHistory = true;
    error = '';

    const result = await apiFetch<{
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      feature: { id: string; title: string; status: string; briefMarkdown: string | null };
    }>(`/api/chat/${id}`, getToken());

    if (result.error) {
      error = result.error;
    } else if (result.data) {
      messages = result.data.messages;
      featureStatus = result.data.feature.status;
      const chatOpenStatuses = ['drafting', 'spec_ready', 'plan_ready', 'tests_ready'];
      if (!chatOpenStatuses.includes(result.data.feature.status)) {
        confirmed = true;
      }
    }
    loadingHistory = false;
  }

  async function sendMessage() {
    if (!canSend) return;

    const userMessage = input.trim();
    input = '';
    error = '';
    streaming = true;
    streamingContent = '';

    // Add user message to display immediately
    messages = [...messages, { role: 'user', content: userMessage }];

    try {
      const response = await fetch(`${PUBLIC_API_URL}/api/chat/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ featureId, message: userMessage }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        error = typeof body.error === 'string' ? body.error : 'Failed to send message';
        streaming = false;
        return;
      }

      if (!response.body) {
        error = 'No response body';
        streaming = false;
        return;
      }

      const reader = response.body.getReader();

      for await (const sseEvent of parseSSE(reader)) {
        if (sseEvent.event === 'metadata') {
          const parsed = JSON.parse(sseEvent.data) as { featureId: string };
          featureId = parsed.featureId;
        } else if (sseEvent.event === 'delta') {
          const parsed = JSON.parse(sseEvent.data) as { text: string };
          streamingContent += parsed.text;
        } else if (sseEvent.event === 'done') {
          // Finalise the assistant message
          messages = [...messages, { role: 'assistant', content: streamingContent }];
          streamingContent = '';
        } else if (sseEvent.event === 'error') {
          const parsed = JSON.parse(sseEvent.data) as { message: string };
          error = parsed.message;
          streamingContent = '';
        }
      }
    } catch {
      error = 'Network error. Please try again.';
      streamingContent = '';
    }

    streaming = false;
  }

  function extractBrief(): string {
    // Find the last message containing ## Brief
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.content.includes('## Brief')) {
        const briefIndex = msg.content.indexOf('## Brief');
        return msg.content.slice(briefIndex);
      }
    }
    return '';
  }

  async function confirmBrief() {
    if (!featureId) return;

    confirming = true;
    error = '';

    const briefMarkdown = extractBrief();
    if (!briefMarkdown) {
      error = 'Could not find the brief in the conversation.';
      confirming = false;
      return;
    }

    const result = await apiFetch<{ success: boolean }>(
      `/api/features/${featureId}/confirm`,
      getToken(),
      { method: 'POST', body: { briefMarkdown } },
    );

    if (result.error) {
      error = result.error;
    } else {
      confirmed = true;
      featureStatus = 'spec_generating';
    }
    confirming = false;
  }

  let isAtApprovalGate = $derived(
    featureStatus === 'spec_ready' || featureStatus === 'plan_ready' || featureStatus === 'tests_ready',
  );

  async function reviseBrief() {
    if (!featureId) return;

    revising = true;
    error = '';

    const briefMarkdown = extractBrief();
    if (!briefMarkdown) {
      error = 'Could not find the brief in the conversation.';
      revising = false;
      return;
    }

    const result = await apiFetch<{ success: boolean }>(
      `/api/features/${featureId}/revise`,
      getToken(),
      { method: 'POST', body: { briefMarkdown } },
    );

    if (result.error) {
      error = result.error;
    } else {
      confirmed = true;
      featureStatus = 'spec_generating';
    }
    revising = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
</script>

<svelte:head>
  <title>New Feature | Build Practical</title>
</svelte:head>

<div class="flex flex-col" style="height: calc(100vh - 73px - 64px);">
  <!-- Header -->
  <div class="mb-4 flex-shrink-0">
    <h1 class="text-2xl font-bold text-slate-900">New Feature</h1>
    <p class="mt-1 text-sm text-slate-500">
      Describe what you want to build and our Business Analyst agent will help
      you refine it into a clear, buildable specification.
    </p>
  </div>

  {#if error}
    <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex-shrink-0">
      {error}
    </div>
  {/if}

  {#if loadingHistory}
    <div class="flex-1 flex items-center justify-center">
      <p class="text-sm text-slate-400">Loading conversation...</p>
    </div>
  {:else}
    <!-- Messages area -->
    <div
      bind:this={messagesContainer}
      class="flex-1 overflow-y-auto space-y-4 pb-4"
    >
      {#if messages.length === 0 && !streaming}
        <div class="flex items-center justify-center h-full">
          <div class="text-center max-w-md">
            <h2 class="text-lg font-semibold text-slate-900">Chat with the BA Agent</h2>
            <p class="mt-2 text-sm text-slate-500">
              Tell the agent what you'd like to build. It will ask clarifying questions
              and help you produce a clear brief for the development pipeline.
            </p>
          </div>
        </div>
      {/if}

      {#each messages as msg}
        {#if msg.role === 'user'}
          <div class="flex justify-end">
            <div class="max-w-[75%] px-4 py-3 bg-brand-600 text-white rounded-lg text-sm whitespace-pre-wrap">
              {msg.content}
            </div>
          </div>
        {:else}
          <div class="flex justify-start">
            <div class="max-w-[75%] px-4 py-3 bg-white border border-slate-200 rounded-lg text-sm text-slate-800 whitespace-pre-wrap">
              {msg.content}
            </div>
          </div>
        {/if}
      {/each}

      <!-- Streaming message -->
      {#if streamingContent}
        <div class="flex justify-start">
          <div class="max-w-[75%] px-4 py-3 bg-white border border-slate-200 rounded-lg text-sm text-slate-800 whitespace-pre-wrap">
            {streamingContent}<span class="inline-block w-1.5 h-4 bg-slate-400 animate-pulse ml-0.5 align-text-bottom"></span>
          </div>
        </div>
      {/if}
    </div>

    <!-- Brief confirmation -->
    {#if briefDetected && !confirmed && !isAtApprovalGate}
      <div class="flex-shrink-0 pb-3">
        <div class="p-4 bg-green-50 border border-green-200 rounded-lg">
          <p class="text-sm text-green-800 font-medium">Brief ready for confirmation</p>
          <p class="mt-1 text-sm text-green-700">
            The agent has produced a brief. Review it above, then confirm to start building.
          </p>
          <button
            onclick={confirmBrief}
            disabled={confirming || streaming}
            class="mt-3 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {confirming ? 'Generating specification...' : 'Confirm brief and start building'}
          </button>
        </div>
      </div>
    {/if}

    <!-- Revise brief at approval gate -->
    {#if briefDetected && isAtApprovalGate && !confirmed}
      <div class="flex-shrink-0 pb-3">
        <div class="p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <p class="text-sm text-amber-800 font-medium">Revised brief detected</p>
          <p class="mt-1 text-sm text-amber-700">
            Confirm to clear downstream deliverables and restart from specification generation.
          </p>
          <button
            onclick={reviseBrief}
            disabled={revising || streaming}
            class="mt-3 px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {revising ? 'Regenerating specification...' : 'Revise brief and rebuild'}
          </button>
        </div>
      </div>
    {/if}

    {#if confirmed}
      <div class="flex-shrink-0 pb-3">
        <div class="p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <p class="text-sm text-blue-800 font-medium">Brief confirmed</p>
          <p class="mt-1 text-sm text-blue-700">
            Your feature is now being processed by the pipeline.
          </p>
          <div class="mt-3 flex gap-3">
            {#if featureId}
              <a
                href="/app/features/{featureId}"
                class="inline-block px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
              >
                View progress
              </a>
            {/if}
            <a
              href="/app"
              class="inline-block px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Back to dashboard
            </a>
          </div>
        </div>
      </div>
    {/if}

    <!-- Input area -->
    {#if !confirmed}
      <div class="flex-shrink-0 border-t border-slate-200 pt-4">
        <div class="flex gap-3">
          <textarea
            bind:value={input}
            onkeydown={handleKeydown}
            placeholder="Describe what you want to build..."
            disabled={streaming}
            rows={2}
            class="flex-1 px-4 py-3 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none disabled:opacity-50 disabled:bg-slate-50"
          ></textarea>
          <button
            onclick={sendMessage}
            disabled={!canSend}
            class="self-end px-5 py-3 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {streaming ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>
