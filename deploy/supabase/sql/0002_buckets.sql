-- 0002 (session E, Supabase only): the private buckets for the new slice.
--
-- One bucket per top-level folder of a key; the object name is the whole key, such as
-- masters/{artist}/{release}/{track}/original. All private: no storage policy grants clients
-- anything here (the app's own policies name only its buckets). Clients upload only with a
-- signed upload token from the server, and read only with a signed link.
--
-- Limits. A bucket's limit cannot be above the project's global file size limit
-- (config.toml [storage] file_size_limit, from MC_FILE_SIZE_LIMIT). Masters get the smaller of
-- that and 5 GiB; covers the smaller of that and 20 MiB. scripts/apply-sql.sh passes it in
-- bytes as mc.file_size_limit; without it, 5 GiB. The Free plan caps a file at 50 MiB (the
-- Phase 0 project, settled); 5 GiB masters need the Pro plan or higher.
--
-- Separate from the app's buckets (covers, audio, profiles, playlist-pictures). Safe to run twice.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('mc-masters', 'mc-masters', false,
   least(5368709120, coalesce(nullif(current_setting('mc.file_size_limit', true), '')::bigint, 5368709120)),
   array['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/aiff', 'audio/x-aiff', 'audio/flac', 'audio/x-flac']),
  -- Streaming copies: format and size are session H's choice, so no type or size limit here
  -- beyond the global one. Set them when H decides.
  ('mc-streams', 'mc-streams', false, null, null),
  ('mc-art', 'mc-art', false,
   least(20971520, coalesce(nullif(current_setting('mc.file_size_limit', true), '')::bigint, 20971520)),
   array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
