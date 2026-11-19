# PureNodeMC

PureNodeMC is an independent Minecraft Java server project implemented in
Node.js. It does not use a Minecraft server JAR, Java, or another server
runtime.

## Current status

The current milestone implements the TCP transport, Minecraft packet framing,
handshake parsing, server-list status response, and ping/pong exchange. It does
**not** implement gameplay login, authentication, players, worlds, chunks, or
gameplay packets yet; connection attempts to enter the world are explicitly
refused. Do not treat this milestone as a playable Minecraft server.

## Requirements

- Node.js 20 or newer

## Run

```sh
npm start
```

By default, the server listens on port `25565`. Edit `config.json` to change
the server name, port, player limit, world settings, or authentication mode.
The advertised protocol is configured for Minecraft Java Edition 1.21.11.

Run the test suite with:

```sh
npm test
```
