# Local Ollama/Qwen workflow

The repository helper `scripts/ollama-qwen-review.sh` sends bounded, non-secret
source context to the locally installed `qwen-local-assistant:latest` model.
It is advisory only: its output is never executed, committed, deployed, or
treated as release approval. Use it for repetitive inspection and drafting,
then run the repository contracts and review the diff yourself.

```bash
npm run review:ollama -- \
  --prompt 'Find SQL ordering or privilege errors and propose a minimal patch.' \
  --file scripts/generate-migration-ledger-verification-sql.mjs \
  --file tests/migration-ledger-verification-contract.mjs
```

The wrapper rejects files outside the repository, credential-like filenames,
and files over 120,000 bytes by default. Set `OLLAMA_MAX_FILE_BYTES` only for a
deliberately reviewed source file. It sets `OLLAMA_NO_CLOUD=1` for the command;
the Ollama server remains bound to loopback and must not be exposed publicly.

After any proposed change, run the relevant contract, `git diff --check`, and
the full `npm run check` before committing. Never pass model output to `eval`,
`sh`, `git`, a deployment command, or a SQL client automatically.
