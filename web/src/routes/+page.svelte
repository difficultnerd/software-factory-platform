<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>Build Practical</title>
</svelte:head>

<div class="flex flex-col min-h-screen">
  <!-- Nav -->
  <nav class="border-b border-slate-200 bg-white">
    <div class="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
      <span class="text-xl font-bold text-slate-900 tracking-tight">Build Practical</span>
      <div class="flex gap-3">
        {#if data.session}
          <a href="/app" class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            Dashboard
          </a>
        {:else}
          <a href="/login" class="px-4 py-2 text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors">
            Log in
          </a>
          <a href="/signup" class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            Sign up
          </a>
        {/if}
      </div>
    </div>
  </nav>

  <!-- Hero -->
  <main class="flex-1 flex items-center justify-center px-6">
    <div class="max-w-2xl text-center">
      <h1 class="text-5xl font-bold text-slate-900 tracking-tight leading-tight">
        Describe software.<br />We build it.
      </h1>
      <p class="mt-6 text-lg text-slate-600 leading-relaxed">
        Tell our AI what you need in plain English. A team of specialised agents will
        write the spec, tests, and code — reviewed for security and quality before
        you ever see it.
      </p>
      <div class="mt-10 flex gap-4 justify-center">
        {#if data.session}
          <a href="/app" class="px-6 py-3 text-base font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            Go to Dashboard
          </a>
        {:else}
          <a href="/signup" class="px-6 py-3 text-base font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            Get started
          </a>
        {/if}
      </div>
    </div>
  </main>

  <!-- Footer -->
  <footer class="border-t border-slate-200 py-6 text-center text-sm text-slate-500">
    Built with care. Secured by design.
  </footer>
</div>
