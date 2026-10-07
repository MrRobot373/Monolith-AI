#!/usr/bin/env bash
# Look for likely secrets in a source tree. Prints file:line with the value masked.
# Usage: bash find_secrets.sh [folder]      (exit 1 if anything was found)
set -u
ROOT="${1:-.}"
PATTERNS=(
  'AKIA[0-9A-Z]{16}'                                              # AWS access key id
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'                         # private keys
  'gh[pousr]_[A-Za-z0-9]{36,}'                                     # GitHub tokens
  'github_pat_[A-Za-z0-9_]{60,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'                                   # Slack tokens
  'sk_(live|test)_[A-Za-z0-9]{20,}'                                # Stripe keys
  'sk-[A-Za-z0-9_-]{20,}'                                          # OpenAI-style keys
  'AIza[0-9A-Za-z_-]{35}'                                          # Google API keys
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' # JWTs
  '(postgres|mysql|mongodb(\+srv)?|redis|amqp)://[^:/ "]+:[^@/ "]+@'   # credentials in URLs
  '(password|passwd|pwd|secret|api_?key|access_?token|auth_?token|client_?secret)["'"'"']?\s*[:=]\s*["'"'"'][^"'"'"' ]{6,}["'"'"']'
)
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=.venv --exclude-dir=venv --exclude-dir=__pycache__ --exclude-dir=.next --exclude=*.lock --exclude=package-lock.json --exclude=*.min.js --exclude=*.map)
found=0
for p in "${PATTERNS[@]}"; do
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    found=1
    # file:line:content → mask anything that looks like the secret value
    printf '%s\n' "$line" | sed -E 's/(:[0-9]+:).*/\1/' | tr -d '\n'
    printf ' %s\n' "$(printf '%s' "${line#*:*:}" | sed -E \
      -e 's#(://[^:/ "]+:)[^@ "]+@#\1••••@#g' \
      -e 's/(["'"'"'])([^"'"'"']{4})[^"'"'"']{4,}(["'"'"'])/\1\2••••\3/g' \
      -e 's/\b(AKIA|gh[pousr]_|github_pat_|xox[baprs]-|sk_live_|sk_test_|sk-|AIza|eyJ)[A-Za-z0-9_.\/+=-]{6,}/\1••••/g' \
      -e 's/-----BEGIN ([A-Z]+ )?PRIVATE KEY-----.*/-----BEGIN \1PRIVATE KEY----- ••••/' | cut -c1-160)"
  done < <(grep -rnIE "${EXCLUDES[@]}" -- "$p" "$ROOT" 2>/dev/null)
done
for f in $(find "$ROOT" -name ".env*" -not -name "*.example" -not -path "*/node_modules/*" 2>/dev/null); do
  echo "$f: environment file present (make sure it is git-ignored and never committed)"
done
if [ "$found" = 0 ]; then echo "No likely secrets found in $ROOT."; fi
exit "$found"
