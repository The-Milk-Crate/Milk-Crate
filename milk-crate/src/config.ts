/**
 * Milk Crate server settings.
 * The publishable key is meant to ship inside apps — what it can do is limited
 * by the row-level security rules in supabase/schema.sql. Never put the
 * secret (service role) key here.
 */
export const SUPABASE_URL = "https://dpnkngadsewzrkedlwmi.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_XU6XAR4PCvNBJbPIlDxiFQ_4mbxrAN_";

/**
 * Largest file the server accepts, in MB. Supabase's free plan caps every file at 50 MB;
 * raise this (and the `audio` bucket's limit in supabase/schema.sql) on a paid plan.
 */
export const MAX_UPLOAD_MB = 50;

/**
 * The share page (milk-crate/site/, published by GitHub Pages). Shared links point here, so they're
 * clickable anywhere (texts, Instagram, email); the page opens them in the app with milkcrate://.
 * If the repository moves or is renamed, change this to match.
 */
export const SHARE_PAGE = "https://the-milk-crate.github.io/Milk-Crate/";
