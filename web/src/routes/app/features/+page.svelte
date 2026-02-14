<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>New Feature | Build Practical</title>
</svelte:head>

<div>
  <h1 class="text-2xl font-bold text-slate-900 mb-8">New Feature</h1>
  <div class="bg-white rounded-xl border border-slate-200 p-12 text-center">
    <div class="text-4xl mb-4">&#x1f4ac;</div>
    <h2 class="text-lg font-semibold text-slate-900">Chat with the BA Agent</h2>
    <p class="mt-2 text-sm text-slate-500 max-w-md mx-auto">
      Describe what you want to build and our Business Analyst agent will help
      you refine it into a clear, buildable feature specification.
    </p>
    <div class="mt-4 p-4 bg-slate-50 rounded-lg border border-dashed border-slate-300 text-center text-sm text-slate-400">
      BA Agent chat interface coming in Session 2
    </div>
  </div>
</div>
