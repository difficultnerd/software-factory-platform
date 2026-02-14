<script lang="ts">
  let { data } = $props();
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
    <div class="mt-4 p-4 bg-slate-50 rounded-lg border border-dashed border-slate-300 text-center text-sm text-slate-400">
      API key management coming in Session 2
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
