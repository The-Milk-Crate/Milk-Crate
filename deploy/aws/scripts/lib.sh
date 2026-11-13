# Shared by the stand-up, confirm and tear-down scripts. Sourced, not run.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
root="$(cd "$pkg/../.." && pwd)"

# Refuses a path inside the repository: real settings and keys live outside it.
outside_repo() {
  local path
  path="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" || { echo "No file $1" >&2; exit 2; }
  case "$path" in
    "$root"/*) echo "$1 is inside the repository. Keep real settings and keys outside it." >&2; exit 2 ;;
  esac
}

# Loads MC_SETTINGS_FILE (NAME=value lines) and checks the settings every script needs.
load_settings() {
  [[ -n "${MC_SETTINGS_FILE:-}" ]] || { echo "Set MC_SETTINGS_FILE (see scripts/settings.env.example)." >&2; exit 2; }
  [[ -f "$MC_SETTINGS_FILE" ]] || { echo "No file $MC_SETTINGS_FILE" >&2; exit 2; }
  outside_repo "$MC_SETTINGS_FILE"
  # NAME=value lines, read as plain text (never run as shell), so a value may hold spaces and <>.
  local line name value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      echo "$MC_SETTINGS_FILE: not a NAME=value line: ${line%%=*}=..." >&2
      exit 2
    fi
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ "$name" == MC_* ]] || { echo "$MC_SETTINGS_FILE: only MC_ settings belong here, not $name" >&2; exit 2; }
    export "$name=$value"
  done <"$MC_SETTINGS_FILE"
  local missing=()
  for var in MC_AWS_ACCOUNT MC_AWS_REGION MC_STACK_NAME MC_OUTPUTS_FILE "$@"; do
    [[ -n "${!var:-}" ]] || missing+=("$var")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then echo "Missing in $MC_SETTINGS_FILE: ${missing[*]}" >&2; exit 2; fi
  [[ "$MC_AWS_ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "MC_AWS_ACCOUNT must be 12 digits." >&2; exit 2; }
  [[ "$MC_AWS_REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { echo "MC_AWS_REGION looks wrong: $MC_AWS_REGION" >&2; exit 2; }
  outside_repo "$MC_OUTPUTS_FILE"
  export AWS_REGION="$MC_AWS_REGION" AWS_DEFAULT_REGION="$MC_AWS_REGION" CDK_DEFAULT_REGION="$MC_AWS_REGION"
  export CDK_DEFAULT_ACCOUNT="$MC_AWS_ACCOUNT"
}

need_tools() {
  local missing=()
  for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  if [[ ${#missing[@]} -gt 0 ]]; then echo "Missing tools: ${missing[*]}" >&2; exit 2; fi
}

# True only in the aws-sandbox workflow (.github/workflows/aws-sandbox.yml): it runs in GitHub
# Actions, and the job waits for K Marcus's approval of the aws-sandbox environment, which stands
# in for typing the account and region again. Anywhere else the scripts always ask.
non_interactive() {
  [[ "${MC_NONINTERACTIVE:-}" == "1" && "${GITHUB_ACTIONS:-}" == "true" && -n "${GITHUB_RUN_ID:-}" ]]
}

# The credentials must be for MC_AWS_ACCOUNT, and K Marcus types the account and region again.
confirm_target() {
  local what="$1" actual
  actual="$(aws sts get-caller-identity --query Account --output text)"
  if [[ "$actual" != "$MC_AWS_ACCOUNT" ]]; then
    echo "Your AWS credentials are for account $actual, not MC_AWS_ACCOUNT=$MC_AWS_ACCOUNT. Stopped." >&2
    exit 1
  fi
  echo "$what"
  echo "  account $MC_AWS_ACCOUNT, region $MC_AWS_REGION, stack $MC_STACK_NAME"
  if non_interactive; then
    echo "  (GitHub Actions: approved in the aws-sandbox environment instead of typing it again)"
    return 0
  fi
  local typed_account typed_region
  read -r -p "Type the account id again to go on: " typed_account
  [[ "$typed_account" == "$MC_AWS_ACCOUNT" ]] || { echo "Stopped."; exit 1; }
  read -r -p "Type the region again to go on: " typed_region
  [[ "$typed_region" == "$MC_AWS_REGION" ]] || { echo "Stopped."; exit 1; }
}

# The stack's outputs as {"Key": "Value"} JSON in MC_OUTPUTS_FILE.
write_outputs() {
  aws cloudformation describe-stacks --stack-name "$MC_STACK_NAME" --query "Stacks[0].Outputs" --output json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o={};for(const x of JSON.parse(s)||[])o[x.OutputKey]=x.OutputValue;process.stdout.write(JSON.stringify(o,null,2)+"\n")})' \
    >"$MC_OUTPUTS_FILE"
}

output() {
  node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=o[process.argv[2]];if(!v){console.error("no output "+process.argv[2]);process.exit(1)}process.stdout.write(v)' "$MC_OUTPUTS_FILE" "$1"
}
