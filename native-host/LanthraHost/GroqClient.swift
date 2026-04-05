// GroqClient.swift — Streaming chat completions via Groq's OpenAI-compatible API.
//
// Uses URLSession with a streaming delegate to emit SSE tokens one by one.
// Reads the API key from the GROQ_API_KEY environment variable (set by the
// install script or by the main Lanthra macOS app via launchd / plist).

import Foundation

enum GroqError: Error {
    case missingAPIKey
    case httpError(Int)
    case streamError(String)
}

// ── Request / response models ─────────────────────────────────────────────────

private struct ChatRequest: Encodable {
    let model:    String
    let messages: [ChatMessage]
    let stream:   Bool = true
    let max_tokens: Int = 2048
}

private struct ChatMessage: Encodable {
    let role:    String
    let content: String
}

// Minimal SSE payload we care about
private struct DeltaChunk: Decodable {
    struct Choice: Decodable {
        struct Delta: Decodable {
            let content: String?
        }
        let delta:         Delta
        let finish_reason: String?
    }
    let choices: [Choice]
}

// ── Client ────────────────────────────────────────────────────────────────────

final class GroqClient: NSObject {

    private let apiKey: String
    private var task:   URLSessionDataTask?

    // Callbacks
    var onToken:     ((String) -> Void)?
    var onStreamEnd: (() -> Void)?
    var onError:     ((Error) -> Void)?

    // SSE line buffer across multiple delegate calls
    private var sseBuffer = ""

    init(apiKey: String) {
        self.apiKey = apiKey
    }

    static func fromEnvironment() throws -> GroqClient {
        guard let key = ProcessInfo.processInfo.environment["GROQ_API_KEY"],
              !key.isEmpty else {
            throw GroqError.missingAPIKey
        }
        return GroqClient(apiKey: key)
    }

    // ── Public ────────────────────────────────────────────────────────────────

    func stream(model: String, prompt: String, context: String) {
        let system = """
        You are an inline AI writing assistant called Lanthra. \
        The user has clicked inside a webpage and typed a brief instruction. \
        Respond with only the replacement or continuation text — no preambles, \
        no explanations, no markdown unless the surrounding text uses it.
        """

        let userMsg = context.isEmpty
            ? prompt
            : "Context from the page:\n\(context)\n\nInstruction: \(prompt)"

        let body = ChatRequest(
            model: model,
            messages: [
                ChatMessage(role: "system",  content: system),
                ChatMessage(role: "user",    content: userMsg),
            ]
        )

        guard let url = URL(string: "https://api.groq.com/openai/v1/chat/completions") else {
            onError?(GroqError.streamError("Bad URL")); return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            request.httpBody = try JSONEncoder().encode(body)
        } catch {
            onError?(error); return
        }

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        task = session.dataTask(with: request)
        task?.resume()
    }

    func cancel() {
        task?.cancel()
        task = nil
    }

    // ── SSE parsing ───────────────────────────────────────────────────────────

    private func processSSEData(_ text: String) {
        sseBuffer += text
        // SSE events are separated by double-newline
        while let range = sseBuffer.range(of: "\n\n") {
            let eventBlock = String(sseBuffer[..<range.lowerBound])
            sseBuffer.removeSubrange(..<range.upperBound)

            for line in eventBlock.components(separatedBy: "\n") {
                guard line.hasPrefix("data: ") else { continue }
                let json = String(line.dropFirst(6))
                if json == "[DONE]" { onStreamEnd?(); return }

                guard let data = json.data(using: .utf8),
                      let chunk = try? JSONDecoder().decode(DeltaChunk.self, from: data),
                      let token = chunk.choices.first?.delta.content, !token.isEmpty
                else { continue }

                onToken?(token)
            }
        }
    }
}

// ── URLSessionDataDelegate ────────────────────────────────────────────────────

extension GroqClient: URLSessionDataDelegate {

    func urlSession(_ session: URLSession,
                    dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            onError?(GroqError.httpError(http.statusCode))
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession,
                    dataTask: URLSessionDataTask,
                    didReceive data: Data) {
        guard let text = String(bytes: data, encoding: .utf8) else { return }
        processSSEData(text)
    }

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        if let error = error as? URLError, error.code == .cancelled { return }
        if let error = error { onError?(error) }
    }
}
