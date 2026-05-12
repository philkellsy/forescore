#!/usr/bin/env bash
set -euo pipefail
mkdir -p docs
pg_dump --schema-only postgresql://localhost:5432/forescore_dev > docs/schema.sql
echo "Schema dumped to docs/schema.sql"
