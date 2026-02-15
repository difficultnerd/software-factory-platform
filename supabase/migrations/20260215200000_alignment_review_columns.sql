-- Alignment review recommendation columns
-- Run this migration manually in the Supabase SQL Editor

ALTER TABLE public.features ADD COLUMN IF NOT EXISTS spec_recommendation text;
ALTER TABLE public.features ADD COLUMN IF NOT EXISTS plan_recommendation text;
ALTER TABLE public.features ADD COLUMN IF NOT EXISTS tests_recommendation text;
