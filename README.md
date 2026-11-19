# PureNodeMC

PureNodeMC is an independent Minecraft Java server project implemented in
Node.js. It does not use a Minecraft server JAR, Java, or another server
runtime.

## Current status

The server supports Minecraft Java Edition 1.21.11 and can authenticate players,
spawn them into a generated flat plains world, stream chunks around them, and
update the streamed area as they move. The default view distance is 32 chunks
in each direction.

This is an early playable prototype, not a complete survival server. World
changes are not persisted, and block interaction, inventory, entities, crafting,
and survival simulation are not implemented yet.

## Requirements

- Node.js 22 or newer

## Run

```sh
npm install
npm start
```

By default, the server listens on port `25565`. Edit `config.json` to change
the server name, port, player limit, view and simulation distances, or
authentication mode. Online authentication is enabled by default.

Run the test suite with:

```sh
npm test
```
