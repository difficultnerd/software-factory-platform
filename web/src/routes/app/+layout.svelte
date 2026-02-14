<script lang="ts">
  import { goto } from '$app/navigation';

  let { data, children } = $props();

  async function handleLogout() {
    await data.supabase.auth.signOut();
    goto('/');
  }
</script>

<div class="min-h-screen bg-slate-50">
  <!-- App nav -->
  <nav class="border-b border-slate-200 bg-white">
    <div class="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
      <div class="flex items-center gap-6">
        <a href="/app" class="text-lg font-bold text-slate-900 tracking-tight">Build Practical</a>
        <div class="flex gap-4 text-sm">
          <a href="/app" class="text-slate-600 hover:text-slate-900 transition-colors">Dashboard</a>
          <a href="/app/settings" class="text-slate-600 hover:text-slate-900 transition-colors">Settings</a>
        </div>
      </div>
      <div class="flex items-center gap-4">
        <span class="text-sm text-slate-500">{data.user?.email}</span>
        <button
          onclick={handleLogout}
          class="text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          Log out
        </button>
      </div>
    </div>
  </nav>

  <!-- Content -->
  <main class="max-w-5xl mx-auto px-6 py-8">
    {@render children()}
  </main>
</div>
