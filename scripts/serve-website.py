#!/usr/bin/env python3
"""Serve the brewlm.com site locally with the same clean URLs as the live host.

/pricing serves pricing.html, the way the live host does, so links like
href="/pricing" work. Everything else is a plain static file server.

Usage: python3 scripts/serve-website.py [port] [directory]
       (defaults: 1440, ../openmindFrontEnd)
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class CleanUrlHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        url = urlsplit(self.path)
        local = self.translate_path(url.path)
        if not os.path.exists(local) and os.path.isfile(local + ".html"):
            self.path = url.path + ".html" + (f"?{url.query}" if url.query else "")
        return super().send_head()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 1440
    root = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "..", "openmindFrontEnd")
    handler = partial(CleanUrlHandler, directory=os.path.abspath(root))
    print(f"Serving {os.path.abspath(root)} at http://localhost:{port}/")
    ThreadingHTTPServer(("", port), handler).serve_forever()
