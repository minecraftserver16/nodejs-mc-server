const fs = require('node:fs/promises');
const path = require('node:path');
const { createMinecraftServer } = require('./network/minecraft-server');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const GAMEMODES = new Set(['survival', 'creative', 'adventure', 'spectator']);
const DIFFICULTIES = new Set(['peaceful', 'easy', 'normal', 'hard']);

async function loadConfig() {
  const text = await fs.readFile(CONFIG_PATH, 'utf8');
  const config = JSON.parse(text);

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Configuration must be a JSON object');
  }
  if (typeof config.serverName !== 'string' || config.serverName.length === 0) {
    throw new TypeError('config.serverName must be a non-empty string');
  }
  if (!Number.isInteger(config.serverPort) || config.serverPort < 0 || config.serverPort > 65535) {
    throw new RangeError('config.serverPort must be an integer from 0 to 65535');
  }
  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < 1) {
    throw new RangeError('config.maxPlayers must be a positive integer');
  }
  if (!Number.isInteger(config.viewDistance) || config.viewDistance < 2) {
    throw new RangeError('config.viewDistance must be an integer of at least 2');
  }
  if (!Number.isInteger(config.simulationDistance) || config.simulationDistance < 2) {
    throw new RangeError('config.simulationDistance must be an integer of at least 2');
  }
  if (!GAMEMODES.has(config.defaultGamemode)) {
    throw new TypeError('config.defaultGamemode is invalid');
  }
  if (!DIFFICULTIES.has(config.difficulty)) {
    throw new TypeError('config.difficulty is invalid');
  }
  if (typeof config.worldSeed !== 'string' && !Number.isSafeInteger(config.worldSeed)) {
    throw new TypeError('config.worldSeed must be a string or safe integer');
  }
  if (typeof config.onlineMode !== 'boolean') {
    throw new TypeError('config.onlineMode must be a boolean');
  }

  return config;
}

async function startServer() {
  const config = await loadConfig();
  const server = createMinecraftServer(config);
  const address = await server.listen();
  console.log(`${config.serverName} status server listening on port ${address.port}`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; shutting down.`);
    try {
      await server.close();
    } catch (error) {
      console.error(`Failed to stop server cleanly: ${error.message}`);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  return server;
}

module.exports = { loadConfig, startServer };
