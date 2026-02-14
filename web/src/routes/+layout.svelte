<script lang="ts">
  import { onMount } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { goto } from '$app/navigation';
  import '../app.css';

  let { data, children } = $props();

  onMount(() => {
    const { data: { subscription } } = data.supabase.auth.onAuthStateChange(
      (_event: string, newSession: unknown) => {
        const ns = newSession as { expires_at?: number } | null;
        const ds = data.session as { expires_at?: number } | null;
        if (ns?.expires_at !== ds?.expires_at) {
          invalidate('supabase:auth');
        }
      },
    );

    return () => subscription.unsubscribe();
  });
</script>

<div class="min-h-screen">
  {@render children()}
</div>
