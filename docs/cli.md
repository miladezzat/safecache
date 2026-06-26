# CLI

The CLI inspects cache state, verifies provider health, invalidates keys and tags, warms cache, and
benchmarks common operations.

```bash
safecache doctor
safecache stats
safecache inspect <key>
safecache invalidate <key>
safecache invalidate-tag <tag>
safecache warm
safecache benchmark
```

`doctor` returns a non-zero exit code when any configured check fails. The exported
`runSafeCacheCli()` helper makes the command surface testable without spawning a process.
