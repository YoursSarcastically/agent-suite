"""Static file server for local preview.

Avoids `python3 -m http.server`, whose argparse block calls os.getcwd() at
import time - which the sandbox denies. Importing the module instead of running
it as __main__ skips that path entirely.
"""
import os
import http.server
import socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8777

os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # WebLLM's WASM path is happier with these, and they cost nothing locally.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving {ROOT} on http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()
