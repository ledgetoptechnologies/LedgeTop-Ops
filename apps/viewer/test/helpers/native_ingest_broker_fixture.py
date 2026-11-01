"""Synthetic Linux-only broker boundary; not a production service or protocol."""
import json
import os
import re
import select
import socket
import struct
import subprocess
import sys

def unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate key')
        value[key] = item
    return value

def main():
    sock_path, db_path, script, allowed_uid = sys.argv[1:]
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    os.chmod(sock_path, 0o666)
    server.listen(4)
    print('READY', flush=True)
    try:
        while True:
            readable, _, _ = select.select([server, sys.stdin], [], [], 30)
            if not readable or sys.stdin in readable:
                break
            conn, _ = server.accept()
            with conn:
                conn.settimeout(5)
                _, uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != int(allowed_uid):
                    conn.sendall(b'{"error":"unauthorized"}\n')
                    continue
                try:
                    data = bytearray()
                    while not data.endswith(b'\n') and len(data) <= 4096:
                        part = conn.recv(4097 - len(data))
                        if not part:
                            break
                        data.extend(part)
                    if not data.endswith(b'\n') or len(data) > 4096:
                        raise ValueError('bad request')
                    req = json.loads(data, object_pairs_hook=unique_pairs)
                    if type(req) is not dict or set(req) != {'operation', 'attemptId', 'jobId'} or req['operation'] != 'complete':
                        raise ValueError('bad request')
                    for key in ('attemptId', 'jobId'):
                        if type(req[key]) is not str or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', req[key]):
                            raise ValueError('bad identity')
                    child = subprocess.Popen(['node', script, db_path, req['attemptId'], req['jobId']],
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    print('CHILD ' + str(child.pid), flush=True)
                    try:
                        stdout, _ = child.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.communicate()
                        raise
                    finally:
                        if child.poll() is None:
                            child.kill()
                            child.communicate()
                        print('REAPED ' + str(child.pid), flush=True)
                    if child.returncode != 0:
                        raise ValueError('transition failed')
                    parsed = json.loads(stdout)
                    if set(parsed) != {'commitId'}:
                        raise ValueError('bad result')
                    conn.sendall(json.dumps(parsed, separators=(',', ':')).encode() + b'\n')
                except Exception:
                    conn.sendall(b'{"error":"hold"}\n')
    finally:
        server.close()
        os.unlink(sock_path)

if __name__ == '__main__':
    main()
