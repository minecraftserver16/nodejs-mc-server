const { encodeVarInt, tryDecodeVarInt } = require('./varint');

function encodeString(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
}

function framePacket(packetId, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([encodeVarInt(packetId), payload]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function decodeString(buffer, offset, maxLength) {
  const length = tryDecodeVarInt(buffer, offset);
  if (!length) return null;
  if (length.value < 0 || length.value > maxLength) {
    throw new RangeError('Protocol string length is invalid');
  }

  const start = offset + length.bytesRead;
  const end = start + length.value;
  if (end > buffer.length) return null;

  return {
    value: buffer.toString('utf8', start, end),
    bytesRead: length.bytesRead + length.value
  };
}

module.exports = { decodeString, encodeString, framePacket };
