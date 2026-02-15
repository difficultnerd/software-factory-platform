-- Migration: Add test and review columns to features table
-- Run manually in Supabase SQL Editor

-- New columns for storing test contracts and review reports
ALTER TABLE public.features ADD COLUMN IF NOT EXISTS tests_markdown text;
ALTER TABLE public.features ADD COLUMN IF NOT EXISTS security_review_markdown text;
ALTER TABLE public.features ADD COLUMN IF NOT EXISTS code_review_markdown text;
