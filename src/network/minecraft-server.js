const net = require('node:net');
const { decodeString, encodeString, framePacket } = require('../protocol/packets');
const { encodeVarInt, tryDecodeVarInt } = require('../protocol/varint');

const MAX_PACKET_LENGTH = 2 * 1024 * 1024;
const PROTOCOL_VERSION = 774;
const MINECRAFT_VERSION = '1.21.11';

class MinecraftServer {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.connections = new Set();
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve(this.server.address());
      };

      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.config.serverPort, this.config.bindAddress);
    });
  }

  close() {
    for (const socket of this.connections) socket.destroy();
    return new Promise((resolve, reject) => {
      if (!this.server.listening) return resolve();
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  handleConnection(socket) {
    this.connections.add(socket);
    socket.setNoDelay(true);

    const client = {
      buffer: Buffer.alloc(0),
      state: 'handshake'
    };

    socket.on('data', (data) => {
      client.buffer = Buffer.concat([client.buffer, data]);
      try {
        this.processPackets(socket, client);
      } catch (error) {
        this.logger.warn(`Closing malformed client packet: ${error.message}`);
        socket.destroy();
      }
    });

    socket.on('error', (error) => {
      this.logger.warn(`Client socket error: ${error.message}`);
    });
    socket.on('close', () => this.connections.delete(socket));
  }

  processPackets(socket, client) {
    while (client.buffer.length > 0 && !socket.destroyed) {
      const packetLength = tryDecodeVarInt(client.buffer);
      if (!packetLength) return;
      if (packetLength.value <= 0 || packetLength.value > MAX_PACKET_LENGTH) {
        throw new RangeError('Packet length is invalid');
      }

      const packetStart = packetLength.bytesRead;
      const packetEnd = packetStart + packetLength.value;
      if (client.buffer.length < packetEnd) return;

      const packet = client.buffer.subarray(packetStart, packetEnd);
      client.buffer = client.buffer.subarray(packetEnd);
      const packetId = tryDecodeVarInt(packet);
      if (!packetId) throw new RangeError('Packet is missing its packet ID');

      const payload = packet.subarray(packetId.bytesRead);
      if (client.state === 'handshake') {
        this.handleHandshake(socket, client, packetId.value, payload);
      } else if (client.state === 'status') {
        this.handleStatus(socket, packetId.value, payload);
      } else if (client.state === 'login') {
        this.refuseLogin(socket, packetId.value);
      }
    }
  }

  handleHandshake(socket, client, packetId, payload) {
    if (packetId !== 0) throw new RangeError('Expected handshake packet');

    const protocol = tryDecodeVarInt(payload);
    if (!protocol) throw new RangeError('Handshake is missing protocol version');
    const address = decodeString(payload, protocol.bytesRead, 255);
    if (!address) throw new RangeError('Handshake is missing server address');

    const portOffset = protocol.bytesRead + address.bytesRead;
    if (payload.length < portOffset + 2) throw new RangeError('Handshake is missing server port');
    const nextState = tryDecodeVarInt(payload, portOffset + 2);
    if (!nextState || nextState.bytesRead + portOffset + 2 !== payload.length) {
      throw new RangeError('Handshake has an invalid next state');
    }

    if (nextState.value === 1) {
      client.state = 'status';
      return;
    }
    if (nextState.value === 2) {
      client.state = 'login';
      return;
    }
    throw new RangeError('Unsupported handshake next state');
  }

  handleStatus(socket, packetId, payload) {
    if (packetId === 0 && payload.length === 0) {
      const response = {
        version: { name: MINECRAFT_VERSION, protocol: PROTOCOL_VERSION },
        players: { max: this.config.maxPlayers, online: 0 },
        description: { text: this.config.serverName }
      };
      socket.write(framePacket(0, encodeString(JSON.stringify(response))));
      return;
    }

    if (packetId === 1 && payload.length === 8) {
      socket.write(framePacket(1, payload));
      return;
    }

    throw new RangeError('Unexpected status packet');
  }

  refuseLogin(socket, packetId) {
    if (packetId !== 0) throw new RangeError('Expected login start packet');

    const reason = {
      text: 'PureNodeMC currently supports server-list status only; gameplay login is not implemented.'
    };
    socket.end(framePacket(0, encodeString(JSON.stringify(reason))));
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
