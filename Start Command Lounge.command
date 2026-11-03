#!/bin/zsh
# Double-click to run the local app in a visible Terminal window.
set -eu
cd -- "${0:A:h}"
for app_bundle in "$HOME/Applications/Lounge.app" "$PWD/dist/Lounge.app"; do
  if [[ -d "$app_bundle" ]]; then
    exec /usr/bin/open "$app_bundle"
  fi
done
if ! command -v node >/dev/null 2>&1; then
  if [[ -x "$HOME/.local/node22/bin/node" ]]; then
    export PATH="$HOME/.local/node22/bin:$PATH"
  else
    print 'Command Lounge needs Node.js 22.13 or newer.'
    read '?Press Return to close.'
    exit 1
  fi
fi
if ! command -v codex >/dev/null 2>&1; then
  for candidate in /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex /Applications/Codex.app/Contents/Resources/codex; do
    if [[ -x "$candidate" ]]; then export CODEX_BIN="$candidate"; break; fi
  done
fi
print 'Starting Command Lounge. Keep this window open; press Ctrl-C to stop.'
print 'Open http://127.0.0.1:4317 in Codex or your browser.'
exec node --disable-warning=ExperimentalWarning server.mjs
