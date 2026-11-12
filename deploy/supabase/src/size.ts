/** The contract's largest master, 5 GiB. */
export const CONTRACT_MASTER_MAX_BYTES = 5 * 1024 ** 3;

const UNITS: Record<string, number> = {
  B: 1, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3,
};

/**
 * The project's file size limit (MC_FILE_SIZE_LIMIT), such as "5GiB" (the default, Pro plan)
 * or "50MiB" (the Free plan's cap). Masters are allowed up to the smaller of it and 5 GiB.
 */
export function parseFileSize(text: string | undefined): number {
  if (text === undefined || text.trim() === "") return CONTRACT_MASTER_MAX_BYTES;
  const m = /^\s*(\d+)\s*(B|KB|MB|GB|KiB|MiB|GiB)\s*$/i.exec(text);
  if (!m) throw new Error(`MC_FILE_SIZE_LIMIT must look like 50MiB or 5GiB, not ${text}`);
  const bytes = Number(m[1]) * UNITS[m[2].toUpperCase()];
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error(`bad MC_FILE_SIZE_LIMIT: ${text}`);
  return Math.min(bytes, CONTRACT_MASTER_MAX_BYTES);
}
