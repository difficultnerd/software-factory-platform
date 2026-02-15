<script lang="ts">
  import { apiFetch } from '$lib/api';

  let { data } = $props();

  let loading = $state(true);
  let saving = $state(false);
  let deleting = $state(false);
  let keyExists = $state(false);
  let hint = $state('');
  let apiKeyInput = $state('');
  let showForm = $state(false);
  let error = $state('');
  let success = $state('');

  let isValidKey = $derived(apiKeyInput.startsWith('sk-ant-') && apiKeyInput.length >= 20);

  function getToken(): string {
    return data.session?.access_token ?? '';
  }

  function clearMessages() {
    error = '';
    success = '';
  }

  async function checkKeyStatus() {
    loading = true;
    clearMessages();
    const result = await apiFetch<{ exists: boolean; hint?: string }>(
      '/api/settings/api-key',
      getToken(),
    );

    if (result.error) {
      error = result.error;
    } else if (result.data) {
      keyExists = result.data.exists;
      hint = result.data.hint ?? '';
    }
    loading = false;
  }

  async function saveKey() {
    saving = true;
    clearMessages();
    const result = await apiFetch<{ success: boolean }>(
      '/api/settings/api-key',
      getToken(),
      { method: 'POST', body: { apiKey: apiKeyInput } },
    );

    if (result.error) {
      error = result.error;
    } else {
      success = 'API key saved successfully.';
      apiKeyInput = '';
      showForm = false;
      await checkKeyStatus();
    }
    saving = false;
  }

  async function deleteKey() {
    deleting = true;
    clearMessages();
    const result = await apiFetch<{ success: boolean }>(
      '/api/settings/api-key',
      getToken(),
      { method: 'DELETE' },
    );

    if (result.error) {
      error = result.error;
    } else {
      success = 'API key deleted.';
      keyExists = false;
      hint = '';
      showForm = false;
    }
    deleting = false;
  }

  $effect(() => {
    checkKeyStatus();
  });
</script>

<svelte:head>
  <title>Settings | Build Practical</title>
</svelte:head>

<div>
  <h1 class="text-2xl font-bold text-slate-900 mb-8">Settings</h1>

  <!-- API Key section -->
  <div class="bg-white rounded-xl border border-slate-200 p-6">
    <h2 class="text-lg font-semibold text-slate-900">Anthropic API Key</h2>
    <p class="mt-1 text-sm text-slate-500">
      Required to run AI agents. Your key is encrypted and never visible after saving.
      Get one at <a href="https://console.anthropic.com/" target="_blank" rel="noopener" class="text-brand-600 hover:text-brand-700">console.anthropic.com</a>.
    </p>

    {#if error}
      <div class="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
        {error}
      </div>
    {/if}

    {#if success}
      <div class="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
        {success}
      </div>
    {/if}

    <div class="mt-4">
      {#if loading}
        <div class="py-4 text-sm text-slate-400">Checking key status...</div>
      {:else if keyExists && !showForm}
        <div class="flex items-center gap-3">
          <div class="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 font-mono">
            sk-ant-{hint}
          </div>
          <button
            onclick={() => { showForm = true; clearMessages(); }}
            class="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Replace
          </button>
          <button
            onclick={deleteKey}
            disabled={deleting}
            class="px-4 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      {:else}
        <div class="space-y-3">
          <div>
            <label for="api-key" class="block text-sm font-medium text-slate-700">API Key</label>
            <input
              type="password"
              id="api-key"
              bind:value={apiKeyInput}
              placeholder="sk-ant-..."
              class="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
            />
            <p class="mt-1 text-xs text-slate-400">Must start with sk-ant- and be at least 20 characters.</p>
          </div>
          <div class="flex items-center gap-3">
            <button
              onclick={saveKey}
              disabled={!isValidKey || saving}
              class="px-4 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save key'}
            </button>
            {#if keyExists}
              <button
                onclick={() => { showForm = false; apiKeyInput = ''; clearMessages(); }}
                class="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 transition-colors"
              >
                Cancel
              </button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- GitHub integration section -->
  <div class="bg-white rounded-xl border border-slate-200 p-6 mt-6">
    <h2 class="text-lg font-semibold text-slate-900">GitHub Integration</h2>
    <p class="mt-1 text-sm text-slate-500">
      Optional. Connect your GitHub account to push generated code to your own repository.
    </p>
    <div class="mt-4 p-4 bg-slate-50 rounded-lg border border-dashed border-slate-300 text-center text-sm text-slate-400">
      GitHub integration coming soon
    </div>
  </div>
</div>
