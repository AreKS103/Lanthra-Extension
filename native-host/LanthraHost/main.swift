// main.swift — Native messaging host entry point.
//
// Chrome Native Messaging protocol:
//   stdin  → 4-byte LE uint32 length + JSON payload
//   stdout → same format
//
// This process runs as a child of Chrome/Chromium. It reads prompts, calls the
// Groq streaming API, and writes token/stream_end/error messages back.
//
// Integration with the main Lanthra app:
//   The install.sh script registers this host. The Groq API key is read from
//   the LANTHRA_GROQ_KEY environment variable, which the main Lanthra app
//   should export via a launchd plist or by writing it to a shared keychain item.

import Foundation

// ── Shared message models ──────────────────────────────────────────────────────

struct IncomingMessage: Decodable {
    let id:      String
    let type:    String
    let prompt:  String?
    let context: String?
    let model:   String?
}

struct OutToken:     Encodable { let id: String; let type = "token";      let token: String }
struct OutStreamEnd: Encodable { let id: String; let type = "stream_end" }
struct OutError:     Encodable { let id: String; let type = "error";      let error: String }

// ── Active Groq sessions ───────────────────────────────────────────────────────

var activeClients: [String: GroqClient] = [:]

func send<T: Encodable>(_ value: T) {
    do {
        try MessageCodec.writeMessage(value)
    } catch {
        // If stdout is broken we cannot do anything; just exit
        fputs("[Lanthra] failed to write message: \(error)\n", stderr)
    }
}

// ── Main read loop ─────────────────────────────────────────────────────────────

fputs("[Lanthra] native host started\n", stderr)

// Disable stdout buffering — Chrome reads in real time
setbuf(stdout, nil)

while true {
    let data: Data
    do {
        data = try MessageCodec.readMessage()
    } catch MessageCodecError.eof {
        fputs("[Lanthra] stdin closed — exiting\n", stderr)
        break
    } catch {
        fputs("[Lanthra] read error: \(error)\n", stderr)
        break
    }

    let msg: IncomingMessage
    do {
        msg = try MessageCodec.decode(data)
    } catch {
        fputs("[Lanthra] decode error: \(error)\n", stderr)
        continue
    }

    switch msg.type {
    case "prompt":
        guard let prompt = msg.prompt else { continue }

        let apiKey = ProcessInfo.processInfo.environment["LANTHRA_GROQ_KEY"]
                  ?? ProcessInfo.processInfo.environment["GROQ_API_KEY"]
                  ?? ""

        guard !apiKey.isEmpty else {
            send(OutError(id: msg.id, error: "Missing LANTHRA_GROQ_KEY environment variable"))
            continue
        }

        let client = GroqClient(apiKey: apiKey)
        activeClients[msg.id] = client

        client.onToken = { token in
            send(OutToken(id: msg.id, token: token))
        }
        client.onStreamEnd = {
            send(OutStreamEnd(id: msg.id))
            activeClients.removeValue(forKey: msg.id)
        }
        client.onError = { error in
            send(OutError(id: msg.id, error: error.localizedDescription))
            activeClients.removeValue(forKey: msg.id)
        }

        client.stream(
            model:   msg.model ?? "llama-3.3-70b-versatile",
            prompt:  prompt,
            context: msg.context ?? ""
        )

        // Keep the run loop alive for async URLSession callbacks
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.001))

    case "cancel":
        activeClients[msg.id]?.cancel()
        activeClients.removeValue(forKey: msg.id)

    default:
        fputs("[Lanthra] unknown message type: \(msg.type)\n", stderr)
    }

    // Drain any pending URLSession callbacks after handling a message
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
}

fputs("[Lanthra] native host exiting\n", stderr)
