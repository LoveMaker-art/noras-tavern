"""Non-generating Python process for real stop/restart ownership tests only."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys


class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"ok":true,"background_jobs":{"running":0,"queued":0}}'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


HTTPServer(('127.0.0.1', int(sys.argv[1])), Health).serve_forever()
