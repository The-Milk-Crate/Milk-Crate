# Milk Crate API contract (Phase 0 slice)

`openapi.yaml` is the contract for release publishing and plays. It runs on both
Supabase and AWS. Platform interfaces are in `../core/src/platform/`.

- Lint: `cd milk-crate && npm run api:lint` (Redocly CLI)
- Regenerate the client: `cd milk-crate && npm run api:client` (writes `src/lib/api/schema.d.ts`)
- Type-check the interfaces: `cd milk-crate && npm run api:core`

## Account type
One claim in the token: `account_type`. Supabase sets it with a custom access token hook.
AWS uses Cognito groups with the same names.

`end_user` · `artist` · `third_party` · `administrator` · `internal` (internal non-admin) · `internal_accounting`

## Who may call what
| Operation | Account types |
|---|---|
| `createRelease`, `resendInvitation`, `startUpload`, `getUpload`, `signUploadParts`, `confirmUpload`, `putRights`, `submitRelease`, `publishRelease` | `artist` (owner only) |
| `respondToSplit` | `end_user`, `artist`, `third_party` (only the invited person) |
| `getRelease` | `artist` (own), `administrator`, `internal` |
| `getPublicRelease`, `getPlayback`, `recordPlays` | every signed-in account |
| `reviewRelease` | `administrator`, `internal` |
| `takedownRelease` | `administrator` |

## Release states
`draft → uploading → processing → awaiting_splits → awaiting_review → scheduled → live`,
plus `needs_changes`, `failed`, `taken_down`. Only the server moves a release.
The full table of moves is in the description at the top of `openapi.yaml`, and each
operation lists its own in `x-state-moves`.
