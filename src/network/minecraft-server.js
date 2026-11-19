const minecraftProtocol = require('minecraft-protocol');
const minecraftData = require('minecraft-data');
const ChunkColumn = require('prismarine-chunk');

const MINECRAFT_VERSION = '1.21.11';
const mcData = minecraftData(MINECRAFT_VERSION);
const PROTOCOL_VERSION = mcData.version.version;
const Chunk = ChunkColumn(MINECRAFT_VERSION);
const CHUNK_BATCH_SIZE = 64;

function createHeightmaps(worldHeight) {
  const bitsPerValue = Math.ceil(Math.log2(worldHeight + 1));
  const valuesPerLong = Math.floor(64 / bitsPerValue);
  const values = Array(Math.ceil(256 / valuesPerLong)).fill(0n);
  const height = 128n;

  for (let index = 0; index < 256; index += 1) {
    const longIndex = Math.floor(index / valuesPerLong);
    const bitOffset = (index % valuesPerLong) * bitsPerValue;
    values[longIndex] |= height << BigInt(bitOffset);
  }

  const data = [
    'world_surface',
    'ocean_floor',
    'motion_blocking',
    'motion_blocking_no_leaves'
  ].map((type) => ({ type, data: values }));

  return data;
}

function createFlatChunkData() {
  const chunk = new Chunk();
  const stateIds = {
    bedrock: mcData.blocksByName.bedrock.minStateId,
    stone: mcData.blocksByName.stone.minStateId,
    dirt: mcData.blocksByName.dirt.minStateId,
    grass: mcData.blocksByName.grass_block.minStateId
  };
  const plainsBiome = mcData.biomesByName.plains.id;
  const maxY = chunk.minY + chunk.worldHeight;

  for (let z = 0; z < 16; z += 1) {
    for (let x = 0; x < 16; x += 1) {
      for (let y = chunk.minY; y < 61; y += 1) {
        chunk.setBlockStateId({ x, y, z }, y === chunk.minY ? stateIds.bedrock : stateIds.stone);
      }
      chunk.setBlockStateId({ x, y: 61, z }, stateIds.dirt);
      chunk.setBlockStateId({ x, y: 62, z }, stateIds.dirt);
      chunk.setBlockStateId({ x, y: 63, z }, stateIds.grass);

      for (let y = 64; y < maxY; y += 1) {
        chunk.setSkyLight({ x, y, z }, 15);
      }
    }
  }

  for (let y = chunk.minY; y < maxY; y += 4) {
    for (let z = 0; z < 16; z += 4) {
      for (let x = 0; x < 16; x += 4) {
        chunk.setBiome({ x, y, z }, plainsBiome);
      }
    }
  }

  for (let index = 0; index <= 8; index += 1) {
    chunk.emptySkyLightMask.set(index, 1);
  }
  for (let index = 0; index < chunk.emptyBlockLightMask.capacity; index += 1) {
    chunk.emptyBlockLightMask.set(index, 1);
  }

  return {
    heightmaps: createHeightmaps(chunk.worldHeight),
    chunkData: chunk.dump(),
    blockEntities: [],
    ...chunk.dumpLight()
  };
}

const flatChunkData = createFlatChunkData();

function chunkKey(x, z) {
  return `${x},${z}`;
}

function isWithinViewDistance(x, z, center, distance) {
  return Math.abs(x - center.x) <= distance && Math.abs(z - center.z) <= distance;
}

class MinecraftServer {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.server = minecraftProtocol.createServer({
      host: config.bindAddress,
      port: config.serverPort,
      version: MINECRAFT_VERSION,
      'online-mode': config.onlineMode,
      motd: config.serverName,
      'max-players': config.maxPlayers
    });
    this.server.on('error', (error) => {
      this.logError(`Minecraft server error: ${error.message}`);
    });
    this.server.on('playerJoin', (client) => this.handlePlayerJoin(client));
  }

  logError(message) {
    if (typeof this.logger.error === 'function') {
      this.logger.error(message);
      return;
    }
    console.error(message);
  }

  listen() {
    const socketServer = this.server.socketServer;
    if (socketServer.listening) return Promise.resolve(socketServer.address());

    return new Promise((resolve, reject) => {
      const onError = (error) => {
        socketServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        socketServer.off('error', onError);
        resolve(socketServer.address());
      };

      socketServer.once('error', onError);
      socketServer.once('listening', onListening);
    });
  }

  close() {
    for (const client of Object.values(this.server.clients)) {
      client.socket.destroy();
    }

    const socketServer = this.server.socketServer;
    if (!socketServer.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      socketServer.close((error) => error ? reject(error) : resolve());
    });
  }

  handlePlayerJoin(client) {
    const state = {
      center: { x: 0, z: 0 },
      loaded: new Set(),
      queued: new Set(),
      queue: [],
      streaming: false,
      batchCount: 0
    };

    try {
      client.write('login', {
        ...mcData.loginPacket,
        entityId: client.id,
        maxPlayers: this.config.maxPlayers,
        viewDistance: this.config.viewDistance,
        simulationDistance: this.config.simulationDistance,
        worldState: {
          ...mcData.loginPacket.worldState,
          gamemode: this.config.defaultGamemode
        }
      });
      client.write('position', {
        teleportId: 0,
        x: 0.5,
        y: 64,
        z: 0.5,
        dx: 0,
        dy: 0,
        dz: 0,
        yaw: 0,
        pitch: 0,
        flags: 0
      });

      client.on('position', (position) => this.updatePlayerPosition(client, state, position));
      client.on('position_look', (position) => this.updatePlayerPosition(client, state, position));
      this.updateChunkView(client, state, 0, 0);
    } catch (error) {
      this.logError(`Failed to initialize player ${client.username}: ${error.message}`);
      client.end('Failed to initialize the world');
    }
  }

  updatePlayerPosition(client, state, position) {
    const chunkX = Math.floor(position.x / 16);
    const chunkZ = Math.floor(position.z / 16);
    if (chunkX === state.center.x && chunkZ === state.center.z) return;
    this.updateChunkView(client, state, chunkX, chunkZ);
  }

  updateChunkView(client, state, centerX, centerZ) {
    state.center = { x: centerX, z: centerZ };
    const viewDistance = this.config.viewDistance;

    client.write('update_view_position', { chunkX: centerX, chunkZ: centerZ });

    for (const key of state.loaded) {
      const [x, z] = key.split(',').map(Number);
      if (!isWithinViewDistance(x, z, state.center, viewDistance)) {
        client.write('unload_chunk', { chunkX: x, chunkZ: z });
        state.loaded.delete(key);
      }
    }

    for (let z = centerZ - viewDistance; z <= centerZ + viewDistance; z += 1) {
      for (let x = centerX - viewDistance; x <= centerX + viewDistance; x += 1) {
        const key = chunkKey(x, z);
        if (state.loaded.has(key) || state.queued.has(key)) continue;
        state.queue.push({ x, z, key });
        state.queued.add(key);
      }
    }

    if (!state.streaming && state.queue.length > 0) this.sendChunkBatch(client, state);
  }

  sendChunkBatch(client, state) {
    if (client.socket.destroyed) return;
    state.streaming = true;
    state.batchCount = 0;
    client.write('chunk_batch_start', {});

    while (state.queue.length > 0 && state.batchCount < CHUNK_BATCH_SIZE) {
      const { x, z, key } = state.queue.shift();
      state.queued.delete(key);
      if (!isWithinViewDistance(x, z, state.center, this.config.viewDistance)) continue;
      if (state.loaded.has(key)) continue;

      client.write('map_chunk', { ...flatChunkData, x, z });
      state.loaded.add(key);
      state.batchCount += 1;
    }

    client.write('chunk_batch_finished', { batchSize: state.batchCount });
    if (state.queue.length > 0) {
      setImmediate(() => this.sendChunkBatch(client, state));
    } else {
      state.streaming = false;
    }
  }
}

function createMinecraftServer(config, logger) {
  return new MinecraftServer(config, logger);
}

module.exports = {
  createMinecraftServer,
  MINECRAFT_VERSION,
  PROTOCOL_VERSION
};
