# Pipes stdin/stdout to the Windows Apple Mobile Device Service (usbmuxd protocol on 127.0.0.1:27015).
import os, socket, sys, threading
s = socket.create_connection(("127.0.0.1", 27015))
stdin = os.fdopen(sys.stdin.fileno(), "rb", buffering=0)
stdout = os.fdopen(sys.stdout.fileno(), "wb", buffering=0)
def up():
    try:
        while True:
            d = stdin.read(65536)
            if not d: break
            s.sendall(d)
    except OSError: pass
    try: s.shutdown(socket.SHUT_WR)
    except OSError: pass
threading.Thread(target=up, daemon=True).start()
try:
    while True:
        d = s.recv(65536)
        if not d: break
        stdout.write(d)
except OSError: pass
