<script lang="ts">
  let { data } = $props();
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

  <!-- Empty state -->
  <div class="bg-white rounded-xl border border-slate-200 p-12 text-center">
    <div class="text-4xl mb-4">&#x1f3d7;</div>
    <h2 class="text-lg font-semibold text-slate-900">No features yet</h2>
    <p class="mt-2 text-sm text-slate-500 max-w-md mx-auto">
      Describe what you want to build, and our AI agents will handle the rest:
      spec, tests, implementation, and security review.
    </p>
    <p class="mt-4 text-sm text-slate-400">
      First, add your Anthropic API key in <a href="/app/settings" class="text-brand-600 hover:text-brand-700">Settings</a>.
    </p>
  </div>
</div>
