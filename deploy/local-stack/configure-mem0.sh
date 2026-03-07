#!/bin/sh
set -eu

MEM0_URL="${MEM0_URL:-http://mem0:8000}"
LLM_MODEL="${MEM0_LLM_MODEL:-gpt-4.1-nano-2025-04-14}"
LLM_TEMPERATURE="${MEM0_LLM_TEMPERATURE:-0.2}"
LLM_BASE_URL="${MEM0_LLM_BASE_URL:-https://api.openai.com/v1}"
LLM_API_KEY="${MEM0_LLM_API_KEY:-}"
EMBED_BASE_URL="http://infinity-embed:7997"
EMBED_MODEL="BAAI/bge-m3"
EMBED_DIMS="1024"
EMBED_API_KEY="local-infinity"

if [ -z "$LLM_API_KEY" ]; then
  echo "[mem0-configurator] MEM0_LLM_API_KEY is required."
  exit 1
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

for i in $(seq 1 60); do
  if curl -fsS "${MEM0_URL}/docs" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

LLM_MODEL_ESC="$(json_escape "$LLM_MODEL")"
EMBED_MODEL_ESC="$(json_escape "$EMBED_MODEL")"
LLM_KEY_ESC="$(json_escape "$LLM_API_KEY")"
EMBED_KEY_ESC="$(json_escape "$EMBED_API_KEY")"
LLM_BASE_ESC="$(json_escape "$LLM_BASE_URL")"
EMBED_BASE_ESC="$(json_escape "$EMBED_BASE_URL")"

PAYLOAD_FILE="$(mktemp)"
RESP_FILE="$(mktemp)"

cat >"$PAYLOAD_FILE" <<EOF
{
  "version": "v1.1",
  "vector_store": {
    "provider": "pgvector",
    "config": {
      "host": "postgres",
      "port": 5432,
      "dbname": "postgres",
      "user": "postgres",
      "password": "postgres",
      "collection_name": "memories"
    }
  },
  "graph_store": {
    "provider": "neo4j",
    "config": {
      "url": "bolt://neo4j:7687",
      "username": "neo4j",
      "password": "mem0graph"
    }
  },
  "llm": {
    "provider": "openai",
    "config": {
      "api_key": "$LLM_KEY_ESC",
      "openai_base_url": "$LLM_BASE_ESC",
      "model": "$LLM_MODEL_ESC",
      "temperature": $LLM_TEMPERATURE
    }
  },
  "embedder": {
    "provider": "openai",
    "config": {
      "api_key": "$EMBED_KEY_ESC",
      "openai_base_url": "$EMBED_BASE_ESC",
      "model": "$EMBED_MODEL_ESC",
      "embedding_dims": $EMBED_DIMS
    }
  },
  "history_db_path": "/app/history/history.db"
}
EOF

HTTP_CODE="$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
  -X POST "${MEM0_URL}/configure" \
  -H "Content-Type: application/json" \
  --data-binary @"$PAYLOAD_FILE")"

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "[mem0-configurator] /configure failed, HTTP=$HTTP_CODE"
  cat "$RESP_FILE"
  exit 1
fi

echo "[mem0-configurator] configured successfully."
