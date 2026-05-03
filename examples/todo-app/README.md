# TODO app — smoke test target

Tiny static page used to smoke-test the full pipeline (plan → record → export).
Serves on `python3 -m http.server 8000` (or any static server).

```bash
# from this directory:
python3 -m http.server 8000

# in another terminal:
cd /path/to/openslate
bun run cli record --url http://localhost:8000 --selector "#add-btn"
```

Expected output: `./demos/smoke-<date>.mp4` (~3-4s, 1080p mp4).

This example exists to verify the pipeline on a real page before any agent
integration. Once the agent path is ready, this is replaced by real product
demos in CI.
