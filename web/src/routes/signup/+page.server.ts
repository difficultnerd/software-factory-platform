import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';

export const actions: Actions = {
  default: async ({ request, locals: { supabase }, url }) => {
    const formData = await request.formData();
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;
    const confirmPassword = formData.get('confirmPassword') as string;

    if (!email || !password) {
      return fail(400, { error: 'Email and password are required', email });
    }

    if (password.length < 12) {
      return fail(400, { error: 'Password must be at least 12 characters', email });
    }

    if (password !== confirmPassword) {
      return fail(400, { error: 'Passwords do not match', email });
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${url.origin}/auth/callback`,
      },
    });

    if (error) {
      return fail(400, { error: error.message, email });
    }

    return { success: true, email };
  },
};
