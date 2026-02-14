import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals: { safeGetSession } }) => {
  const { session, user } = await safeGetSession();

  if (!session || !user) {
    throw redirect(303, '/login');
  }

  return { session, user };
};
