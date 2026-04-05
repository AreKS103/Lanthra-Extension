// MessageCodec.swift — Native Messaging protocol en/decoder.
//
// Chrome Native Messaging uses a 4-byte little-endian uint32 length prefix
// followed by a UTF-8 JSON payload, on both stdin (incoming) and stdout (outgoing).

import Foundation

enum MessageCodecError: Error {
    case eof
    case invalidUTF8
    case decodeFailed(String)
}

struct MessageCodec {

    // ── Read ─────────────────────────────────────────────────────────────────

    /// Block-reads one message from `stdin`. Returns nil at EOF.
    static func readMessage() throws -> Data {
        // Read 4-byte length prefix
        let lenData = FileHandle.standardInput.readData(ofLength: 4)
        guard lenData.count == 4 else { throw MessageCodecError.eof }

        let len = lenData.withUnsafeBytes { ptr in
            ptr.loadUnaligned(as: UInt32.self).littleEndian
        }

        guard len > 0, len < 1_000_000 else { throw MessageCodecError.eof }

        let payload = FileHandle.standardInput.readData(ofLength: Int(len))
        guard payload.count == Int(len) else { throw MessageCodecError.eof }
        return payload
    }

    /// Decode a JSON message into a Decodable type.
    static func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MessageCodecError.decodeFailed(error.localizedDescription)
        }
    }

    // ── Write ────────────────────────────────────────────────────────────────

    /// Encode and write one message to `stdout`.
    static func writeMessage<T: Encodable>(_ value: T) throws {
        let payload = try JSONEncoder().encode(value)
        var len = UInt32(payload.count).littleEndian
        let lenData = Data(bytes: &len, count: 4)
        FileHandle.standardOutput.write(lenData)
        FileHandle.standardOutput.write(payload)
    }
}
