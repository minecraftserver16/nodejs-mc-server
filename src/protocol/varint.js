function encodeVarInt(value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError('VarInt value must be a signed 32-bit integer');
  }

  const bytes = [];
  let remaining = value >>> 0;

  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);

  return Buffer.from(bytes);
}

function tryDecodeVarInt(buffer, offset = 0) {
  let value = 0;

  for (let index = 0; index < 5; index += 1) {
    const position = offset + index;
    if (position >= buffer.length) return null;

    const byte = buffer[position];
    if (index === 4 && (byte & 0xf0) !== 0) {
      throw new RangeError('VarInt exceeds 32 bits');
    }

    value |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) {
      return { value: value | 0, bytesRead: index + 1 };
    }
  }

  throw new RangeError('VarInt exceeds five bytes');
}

module.exports = { encodeVarInt, tryDecodeVarInt };
