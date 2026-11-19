const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const minecraftProtocol = require('minecraft-protocol');
const minecraftData = require('minecraft-data');
const prismarineChunk = require('prismarine-chunk');
const {
  createMinecraftServer,
  MINECRAFT_VERSION,
  PROTOCOL_VERSION
} = require('../src/network/minecraft-server');
const { encodeString, framePacket } = require('../src/protocol/packets');
const { encodeVarInt, tryDecodeVarInt } = require('../src/protocol/varint');
const { loadConfig } = require('../src/server');

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

function makeServerConfig(overrides = {}) {
  return {
    serverPort: 0,
    serverName: 'Test server',
    maxPlayers: 12,
    viewDistance: 2,
    simulationDistance: 2,
    defaultGamemode: 'survival',
    onlineMode: false,
    ...overrides
  };
}

function waitForPacket(client, packetName, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      client.off(packetName, onPacket);
      client.off('error', onError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${packetName}`));
    }, 10000);
    const onPacket = (packet) => {
      if (!predicate(packet)) return;
      cleanup();
      resolve(packet);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    client.on(packetName, onPacket);
    client.once('error', onError);
  });
}

function waitForChunkCount(client, expectedCount) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const timeout = setTimeout(() => {
      client.off('map_chunk', onChunk);
      reject(new Error(`Received ${count} of ${expectedCount} expected chunks`));
    }, 30000);
    const onChunk = () => {
      count += 1;
      if (count !== expectedCount) return;
      clearTimeout(timeout);
      client.off('map_chunk', onChunk);
      resolve(count);
    };
    client.on('map_chunk', onChunk);
    client.once('error', (error) => {
      clearTimeout(timeout);
      client.off('map_chunk', onChunk);
      reject(error);
    });
  });
}

test('VarInt encodes and decodes boundary values', () => {
  for (const value of [0, 1, 127, 128, 255, 2147483647, -1, -2147483648]) {
    const encoded = encodeVarInt(value);
    assert.deepEqual(tryDecodeVarInt(encoded), { value, bytesRead: encoded.length });
  }
});

test('default configuration uses a 32-chunk view distance', async () => {
  const config = await loadConfig();
  assert.equal(config.viewDistance, 32);
});

test('status handshake returns server information and answers ping', async (t) => {
  const server = createMinecraftServer(makeServerConfig(), {
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
  assert.equal(status.version.name, MINECRAFT_VERSION);
  assert.equal(status.version.protocol, PROTOCOL_VERSION);
  assert.equal(status.players.max, 12);
  assert.equal(status.description.text, 'Test server');

  const ping = Buffer.from('12345678');
  socket.write(framePacket(1, ping));
  const pongPacket = await readPacket(socket);
  assert.equal(tryDecodeVarInt(pongPacket).value, 1);
  assert.deepEqual(pongPacket.subarray(1), ping);
});

test('players can join the flat world and stream chunks as they move', async (t) => {
  const server = createMinecraftServer(makeServerConfig(), {
    warn() {},
    error(message) {
      console.error(message);
    }
  });
  const address = await server.listen();
  const client = minecraftProtocol.createClient({
    host: '127.0.0.1',
    port: address.port,
    username: 'Player',
    auth: 'offline',
    version: MINECRAFT_VERSION
  });
  t.after(async () => {
    await server.close();
  });

  const loginPromise = waitForPacket(client, 'login');
  const positionPromise = waitForPacket(client, 'position');
  const firstChunkPromise = waitForPacket(client, 'map_chunk');
  const firstBatchPromise = waitForPacket(client, 'chunk_batch_finished');
  const [login, position, firstChunk] = await Promise.all([
    loginPromise,
    positionPromise,
    firstChunkPromise,
    firstBatchPromise
  ]);
  assert.equal(login.viewDistance, 2);
  assert.equal(position.y, 64);
  assert.ok(Buffer.isBuffer(firstChunk.chunkData));
  const chunk = new (prismarineChunk(MINECRAFT_VERSION))();
  chunk.load(firstChunk.chunkData);
  const blocks = minecraftData(MINECRAFT_VERSION).blocksByName;
  assert.equal(chunk.getBlockStateId({ x: 0, y: 63, z: 0 }), blocks.grass_block.minStateId);
  assert.equal(chunk.getBlockStateId({ x: 0, y: 62, z: 0 }), blocks.dirt.minStateId);
  assert.equal(chunk.getBlockStateId({ x: 0, y: -64, z: 0 }), blocks.bedrock.minStateId);

  const nextChunkPromise = waitForPacket(client, 'map_chunk', (chunk) => chunk.x === 3);
  client.write('position', {
    x: 16.5,
    y: 64,
    z: 0.5,
    flags: { onGround: true, hasHorizontalCollision: false }
  });
  const nextChunk = await nextChunkPromise;
  assert.equal(nextChunk.z, -2);
  assert.equal(MINECRAFT_VERSION, '1.21.11');
  assert.equal(PROTOCOL_VERSION, 774);
});

test('view distance 32 streams a 65 by 65 chunk area', async (t) => {
  const server = createMinecraftServer(makeServerConfig({ viewDistance: 32 }), {
    warn() {}
  });
  const address = await server.listen();
  const client = minecraftProtocol.createClient({
    host: '127.0.0.1',
    port: address.port,
    username: 'WideViewTester',
    auth: 'offline',
    version: MINECRAFT_VERSION
  });
  t.after(() => server.close());

  const loginPromise = waitForPacket(client, 'login');
  const chunkCountPromise = waitForChunkCount(client, 65 * 65);
  const [login, chunkCount] = await Promise.all([loginPromise, chunkCountPromise]);
  assert.equal(login.viewDistance, 32);
  assert.equal(chunkCount, 4225);
});

test('incomplete VarInt remains buffered and malformed VarInt is rejected', () => {
  assert.equal(tryDecodeVarInt(Buffer.from([0x80])), null);
  assert.throws(() => tryDecodeVarInt(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x10])), /32 bits/);
});
