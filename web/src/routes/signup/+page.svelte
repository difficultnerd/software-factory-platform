<script lang="ts">
  import { enhance } from '$app/forms';

  let { form } = $props();
</script>

<svelte:head>
  <title>Sign up | Build Practical</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center px-6 bg-slate-50">
  <div class="w-full max-w-sm">
    <div class="text-center mb-8">
      <a href="/" class="text-xl font-bold text-slate-900 tracking-tight">Build Practical</a>
    </div>

    {#if form?.success}
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
        <h2 class="text-lg font-semibold text-slate-900">Check your email</h2>
        <p class="mt-2 text-sm text-slate-600">
          We sent a confirmation link to <strong>{form.email}</strong>. Click it to activate your account.
        </p>
        <a href="/login" class="mt-6 inline-block text-sm text-brand-600 hover:text-brand-700 font-medium">
          Go to login
        </a>
      </div>
    {:else}
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <h2 class="text-lg font-semibold text-slate-900 text-center">Create your account</h2>

        {#if form?.error}
          <div class="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {form.error}
          </div>
        {/if}

        <form method="POST" use:enhance class="mt-6 space-y-4">
          <div>
            <label for="email" class="block text-sm font-medium text-slate-700">Email</label>
            <input
              type="email"
              id="email"
              name="email"
              value={form?.email ?? ''}
              required
              class="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
            />
          </div>

          <div>
            <label for="password" class="block text-sm font-medium text-slate-700">Password</label>
            <input
              type="password"
              id="password"
              name="password"
              required
              minlength={12}
              class="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
            />
            <p class="mt-1 text-xs text-slate-500">Minimum 12 characters</p>
          </div>

          <div>
            <label for="confirmPassword" class="block text-sm font-medium text-slate-700">Confirm password</label>
            <input
              type="password"
              id="confirmPassword"
              name="confirmPassword"
              required
              minlength={12}
              class="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
            />
          </div>

          <button
            type="submit"
            class="w-full py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
          >
            Create account
          </button>
        </form>

        <p class="mt-6 text-center text-sm text-slate-500">
          Already have an account? <a href="/login" class="text-brand-600 hover:text-brand-700 font-medium">Log in</a>
        </p>
      </div>
    {/if}
  </div>
</div>
