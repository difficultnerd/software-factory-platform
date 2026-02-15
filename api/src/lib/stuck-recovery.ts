/**
 * @file Stuck feature recovery
 * @purpose Scheduled handler that finds features stuck in non-terminal states and auto-fails them
 * @invariants Uses service client (no user context); only touches features older than threshold
 */

import { createServiceClient } from './supabase.js';
import { logger } from './logger.js';
import type { Bindings } from '../types.js';

/** Features stuck in these statuses for longer than the threshold are considered stuck */
const STUCK_STATUSES = ['spec_generating', 'plan_generating', 'tests_generating', 'implementing', 'review'];

/** Minutes before a feature in a processing state is considered stuck */
const STUCK_THRESHOLD_MINUTES = 10;

export async function recoverStuckFeatures(env: Bindings): Promise<void> {
  const serviceClient = createServiceClient(env);

  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data: stuckFeatures, error: fetchError } = await serviceClient
    .from('features')
    .select('id, status, updated_at')
    .in('status', STUCK_STATUSES)
    .lt('updated_at', cutoff);

  if (fetchError) {
    logger.error({
      event: 'recovery.fetch_stuck',
      actor: 'system',
      outcome: 'failure',
      metadata: { error: fetchError.message },
    });
    return;
  }

  if (!stuckFeatures || stuckFeatures.length === 0) {
    return;
  }

  const features = stuckFeatures as Array<{ id: string; status: string; updated_at: string }>;

  logger.info({
    event: 'recovery.found_stuck',
    actor: 'system',
    outcome: 'info',
    metadata: { count: features.length, ids: features.map(f => f.id) },
  });

  for (const feature of features) {
    const { error: updateError } = await serviceClient
      .from('features')
      .update({
        status: 'failed',
        error_message: `Pipeline timed out after ${STUCK_THRESHOLD_MINUTES} minutes in "${feature.status}" status. Use "Retry from last checkpoint" to try again.`,
      })
      .eq('id', feature.id)
      .eq('status', feature.status); // Only update if still in the same stuck status (prevents race)

    if (updateError) {
      logger.error({
        event: 'recovery.update_stuck',
        actor: 'system',
        outcome: 'failure',
        metadata: { featureId: feature.id, error: updateError.message },
      });
    } else {
      logger.info({
        event: 'recovery.recovered',
        actor: 'system',
        outcome: 'success',
        metadata: { featureId: feature.id, previousStatus: feature.status },
      });
    }
  }
}
