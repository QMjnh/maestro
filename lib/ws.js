// Minimal WebSocket client (text frames only) — enough for the Chrome DevTools Protocol,
// without needing `npm install ws` or Node's experimental WebSocket flag.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

function xor(data, mask) {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i & 3];
  return out;
}

class WsClient extends EventEmitter {
  static connect(url, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        timeout,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        },
      });
      req.on('upgrade', (res, socket, head) => {
        socket.setTimeout(0);
        socket.setNoDelay(true);
        resolve(new WsClient(socket, head));
      });
      req.on('response', (res) => reject(new Error(`WebSocket upgrade refused (${res.statusCode})`)));
      req.on('timeout', () => req.destroy(new Error('WebSocket connect timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.open = true;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    if (head && head.length) this._onData(head);
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) payload = xor(payload, this.buf.subarray(maskOff, maskOff + 4));
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) this._send(0xa, payload);
      else if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.emit('message', text);
        }
      }
    }
  }

  _send(opcode, payload) {
    if (!this.open) throw new Error('WebSocket is closed');
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = 0x80 | len;
    else if (len < 65536) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    this.socket.write(Buffer.concat([header, mask, xor(payload, mask)]));
  }

  send(text) {
    this._send(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    if (this.open) {
      try {
        this._send(0x8, Buffer.alloc(0));
      } catch {}
    }
    this.socket.end();
    this._closed();
  }
}

module.exports = { WsClient };
