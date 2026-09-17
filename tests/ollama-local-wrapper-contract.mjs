import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapperPath = path.join(root, 'scripts', 'ollama-qwen-review.sh');
const source = await fs.readFile(wrapperPath, 'utf8');

assert.match(source, /OLLAMA_NO_CLOUD=1\s+ollama run/);
assert.match(source, /--think=false\s+--hidethinking\s+--nowordwrap/);
assert.match(source, /ollama show "\$model"/);
assert.match(source, /source file must be inside the repository/);
assert.match(source, /credential-like file/);
assert.match(source, /bytes <= max_file_bytes/);
assert.doesNotMatch(source, /\beval\b/);
assert.doesNotMatch(source, /\|\s*(?:sh|bash)\b/);
assert.doesNotMatch(source, /\|\s*(?:psql|git)\b/);

console.log('Local Ollama wrapper contract passed: loopback-only, bounded source, no automatic execution');
