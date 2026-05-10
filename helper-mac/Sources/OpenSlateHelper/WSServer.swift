// WSServer.swift
//
// Tiny WebSocket server bound to 127.0.0.1. Uses Network.framework's
// NWProtocolWebSocket to handle RFC 6455 framing — the alternative
// would be ~300 lines of bit-twiddling for handshake + frame parsing,
// which I'd rather not maintain.
//
// Single-client. The browser tab is the only intended consumer; if a
// second client connects, the first is dropped. We trust the loopback
// boundary: no auth, no TLS.

import Foundation
import Network

@MainActor
final class WSServer {
    let portNumber: UInt16
    private let port: NWEndpoint.Port
    private var listener: NWListener?
    private var connection: NWConnection?

    var onMessage: ((String) -> Void)?
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?

    init(port: UInt16) {
        self.portNumber = port
        self.port = NWEndpoint.Port(rawValue: port)!
    }

    func start() throws {
        let params = NWParameters(tls: nil)
        params.allowLocalEndpointReuse = true
        // Restrict to the loopback interface so the helper isn't
        // reachable from the LAN. requiredInterfaceType is the
        // listener-side equivalent of "bind 127.0.0.1 only."
        params.requiredInterfaceType = .loopback
        let opts = NWProtocolWebSocket.Options()
        opts.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(opts, at: 0)

        let l = try NWListener(using: params, on: port)
        l.newConnectionHandler = { [weak self] conn in
            Task { @MainActor in self?.adopt(conn) }
        }
        l.start(queue: .main)
        self.listener = l
    }

    func stop() {
        connection?.cancel()
        connection = nil
        listener?.cancel()
        listener = nil
    }

    func send(_ text: String) {
        guard let conn = connection else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(
            identifier: "send", metadata: [metadata]
        )
        let data = text.data(using: .utf8) ?? Data()
        conn.send(
            content: data,
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { _ in }
        )
    }

    // MARK: - private

    private func adopt(_ conn: NWConnection) {
        // Drop any prior connection — single-client by design.
        if let prior = connection {
            prior.cancel()
        }
        self.connection = conn
        conn.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self = self else { return }
                switch state {
                case .ready:
                    self.onConnect?()
                    self.receive(on: conn)
                case .failed, .cancelled:
                    if conn === self.connection {
                        self.connection = nil
                        self.onDisconnect?()
                    }
                default:
                    break
                }
            }
        }
        conn.start(queue: .main)
    }

    private func receive(on conn: NWConnection) {
        conn.receiveMessage { [weak self] data, context, _, error in
            Task { @MainActor in
                guard let self = self else { return }
                if error != nil { return }
                if let data = data,
                    let metadata = context?.protocolMetadata.first as? NWProtocolWebSocket.Metadata,
                    metadata.opcode == .text,
                    let text = String(data: data, encoding: .utf8)
                {
                    self.onMessage?(text)
                }
                if conn === self.connection {
                    self.receive(on: conn)
                }
            }
        }
    }
}
