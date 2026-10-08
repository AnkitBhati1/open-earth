import argparse
import socket
import sys
from pathlib import Path

import uvicorn

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
parser = argparse.ArgumentParser(description="Start the local Open Earth workspace")
parser.add_argument("--port", type=int, default=8765)
args = parser.parse_args()
if not (root / "dist" / "index.html").exists():
    raise SystemExit("Build the web app first: npm install && npm run build")
port = args.port
for candidate in range(args.port, args.port + 20):
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", candidate))
            port = candidate
            break
        except OSError:
            continue
else:
    raise SystemExit("No free local port. Choose one with --port.")
print(f"Open Earth: http://127.0.0.1:{port}", flush=True)
uvicorn.run("server.main:app", host="127.0.0.1", port=port)