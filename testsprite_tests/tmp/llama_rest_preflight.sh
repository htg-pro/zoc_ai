#!/usr/bin/env bash
# Pre-flight llama.cpp REST checks for Zoc AI live stack
set -euo pipefail
BASE="${LLAMA_BASE:-http://127.0.0.1:8080}"
PASS=0
FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== llama.cpp REST preflight @ $BASE ==="

code=$(curl -s -o /tmp/health.json -w "%{http_code}" "$BASE/health")
body=$(cat /tmp/health.json)
if [[ "$code" == "200" && "$body" == *'"status":"ok"'* ]]; then ok "GET /health 200 status ok"; else bad "GET /health (code=$code body=$body)"; fi

props=$(curl -s "$BASE/props")
n_ctx=$(echo "$props" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('default_generation_settings',{}).get('n_ctx',''))")
model_path=$(echo "$props" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model_path',''))")
if [[ -n "$n_ctx" && "$n_ctx" != "None" ]]; then ok "GET /props n_ctx=$n_ctx model=$model_path"; else bad "GET /props missing n_ctx"; fi
# n_gpu_layers may not appear in /props on all builds; infer GPU from -ngl via slots/metrics if needed
if echo "$props" | grep -qi gpu; then ok "GET /props mentions GPU fields"; else echo "NOTE: /props has no n_gpu_layers field (llama.cpp build); verify GPU via server -ngl 99 startup"; fi

models=$(curl -s "$BASE/v1/models")
mid=$(echo "$models" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'] if d.get('data') else '')")
if [[ -n "$mid" ]]; then ok "GET /v1/models id=$mid"; else bad "GET /v1/models empty"; fi

# Streaming chat
stream_out=$(curl -sN -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"$mid"'","messages":[{"role":"user","content":"Say hi in 3 words."}],"stream":true,"max_tokens":32}' \
  --max-time 120 | head -c 8000)
if echo "$stream_out" | grep -q 'data:' && echo "$stream_out" | grep -q 'finish_reason'; then
  ok "POST /v1/chat/completions stream=true SSE + finish_reason"
else
  bad "POST /v1/chat/completions stream (len=${#stream_out})"
fi

comp=$(curl -s -X POST "$BASE/completion" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"2+2=","n_predict":16,"stream":false}')
content=$(echo "$comp" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('content') or d.get('completion') or '')[:80])")
if [[ -n "$content" ]]; then ok "POST /completion non-empty: ${content//[$'\n']/}"; else bad "POST /completion empty"; fi

tok=$(curl -s -X POST "$BASE/tokenize" -H 'Content-Type: application/json' -d '{"content":"hello world"}')
ntok=$(echo "$tok" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('tokens',[])))")
det=$(curl -s -X POST "$BASE/detokenize" -H 'Content-Type: application/json' -d "{\"tokens\": $(echo "$tok" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('tokens',[])))")}")
back=$(echo "$det" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('content',''))")
if [[ "$back" == "hello world" && "$ntok" -gt 0 ]]; then ok "tokenize/detokenize round-trip n=$ntok"; else bad "tokenize/detokenize (back=$back n=$ntok)"; fi

err_code=$(curl -s -o /tmp/err.json -w "%{http_code}" -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d '{not json}')
if [[ "$err_code" =~ ^4 ]]; then ok "malformed body -> HTTP $err_code"; else bad "malformed body expected 4xx got $err_code"; fi

slots=$(curl -s "$BASE/slots" || true)
if [[ -n "$slots" ]]; then ok "GET /slots responded"; else bad "GET /slots failed"; fi

echo "=== Summary: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
