const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { createMinecraftServer, PROTOCOL_VERSION } = require('../src/network/minecraft-server');
const { encodeString, framePacket } = require('../src/protocol/packets');
const { encodeVarInt, tryDecodeVarInt } = require('../src/protocol/varint');

function makeHandshake(nextState) {
  const payload = Buffer.concat([
    encodeVarInt(PROTOCOL_VERSION),
    encodeString('localhost'),
    Buffer.from([0x63, 0xdd]),
    encodeVarInt(nextState)
  ]);
  return framePacket(0, payload);
}

function readPacket(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (data) => {
      buffer = Buffer.concat([buffer, data]);
      const length = tryDecodeVarInt(buffer);
      if (!length || buffer.length < length.bytesRead + length.value) return;
      socket.off('data', onData);
      socket.off('error', onError);
      resolve(buffer.subarray(length.bytesRead, length.bytesRead + length.value));
    };
    const onError = (error) => {
      socket.off('data', onData);
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

test('VarInt encodes and decodes boundary values', () => {
  for (const value of [0, 1, 127, 128, 255, 2147483647, -1, -2147483648]) {
    const encoded = encodeVarInt(value);
    assert.deepEqual(tryDecodeVarInt(encoded), { value, bytesRead: encoded.length });
  }
});

test('status handshake returns server information and answers ping', async (t) => {
  const server = createMinecraftServer({ serverPort: 0, serverName: 'Test server', maxPlayers: 12 }, {
    warn() {}
  });
  const address = await server.listen();
  t.after(() => server.close());

  const socket = net.createConnection(address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(makeHandshake(1));
  socket.write(framePacket(0));
  const statusPacket = await readPacket(socket);
  const statusId = tryDecodeVarInt(statusPacket);
  assert.equal(statusId.value, 0);
  const jsonLength = tryDecodeVarInt(statusPacket, statusId.bytesRead);
  const status = JSON.parse(
    statusPacket.toString('utf8', statusId.bytesRead + jsonLength.bytesRead)
  );
  assert.equal(status.version.protocol, PROTOCOL_VERSION);
  assert.equal(status.players.max, 12);
  assert.equal(status.description.text, 'Test server');

  const ping = Buffer.from('12345678');
  socket.write(framePacket(1, ping));
  const pongPacket = await readPacket(socket);
  assert.equal(tryDecodeVarInt(pongPacket).value, 1);
  assert.deepEqual(pongPacket.subarray(1), ping);
});

test('login handshake is explicitly refused instead of accepting gameplay', async (t) => {
  const server = createMinecraftServer({ serverPort: 0, serverName: 'Test server', maxPlayers: 12 }, {
    warn() {}
  });
  const address = await server.listen();
  t.after(() => server.close());

  const socket = net.createConnection(address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(makeHandshake(2));
  socket.write(framePacket(0, encodeString('Player')));
  const disconnect = await readPacket(socket);
  const packetId = tryDecodeVarInt(disconnect);
  assert.equal(packetId.value, 0);
  const messageLength = tryDecodeVarInt(disconnect, packetId.bytesRead);
  const message = JSON.parse(
    disconnect.toString('utf8', packetId.bytesRead + messageLength.bytesRead)
  );
  assert.match(message.text, /gameplay login is not implemented/);
});

test('incomplete VarInt remains buffered and malformed VarInt is rejected', () => {
  assert.equal(tryDecodeVarInt(Buffer.from([0x80])), null);
  assert.throws(() => tryDecodeVarInt(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x10])), /32 bits/);
});

test('malformed frame length closes the client connection safely', async (t) => {
  const server = createMinecraftServer({ serverPort: 0, serverName: 'Test server', maxPlayers: 12 }, {
    warn() {}
  });
  const address = await server.listen();
  t.after(() => server.close());

  const socket = net.createConnection(address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x10]));
  await closed;
});
