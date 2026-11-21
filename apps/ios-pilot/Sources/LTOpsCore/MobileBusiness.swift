import Foundation

public struct MobileBusinessRoot: Decodable, Equatable, Sendable, Identifiable {
    public struct Identity: Hashable, Sendable { let source: String; let kind: String; let root: String }
    public let sourceId: String
    public let rootNamespace: String
    public let kind: String
    public let clientHubRootId: String
    public let name: String
    public var id: Identity { Identity(source: sourceId, kind: kind, root: clientHubRootId) }
    public var isValid: Bool {
        sourceId == "project-alpha:staging" && rootNamespace == "business" &&
        ["organization", "standalone_client"].contains(kind) && validText(clientHubRootId, max: 512) &&
        clientHubRootId != "." && clientHubRootId != ".." && validText(name, max: 512)
    }
}

public struct MobileBusinessProject: Decodable, Equatable, Sendable, Identifiable {
    public struct Identity: Hashable, Sendable { let origin: String; let key: String }
    public let idValue: String
    public let origin: String
    public let name: String
    public let status: String?
    public let startDate: String?
    public let endDate: String?
    enum CodingKeys: String, CodingKey { case idValue = "id", origin, name, status, startDate, endDate }
    public var id: Identity { Identity(origin: origin, key: idValue) }
    public var isValid: Bool {
        validText(idValue, max: 512) && ["pa", "canonical"].contains(origin) && validText(name, max: 512) &&
        validOptional(status, max: 128) && validOptional(startDate, max: 64) && validOptional(endDate, max: 64)
    }
}

public struct MobileBusinessRootsPage: Decodable, Sendable {
    public let schemaVersion: Int
    public let roots: [MobileBusinessRoot]
    public let nextCursor: String?
}
public struct MobileBusinessProjectsPage: Decodable, Sendable {
    public let schemaVersion: Int
    public let projects: [MobileBusinessProject]
    public let nextCursor: String?
}

private func validText(_ text: String, max: Int) -> Bool {
    !text.isEmpty && text.utf16.count <= max && !text.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
}
private func validOptional(_ text: String?, max: Int) -> Bool { text.map { validText($0, max: max) } ?? true }
private func validCursor(_ cursor: String?) -> Bool {
    guard let cursor else { return true }
    return !cursor.isEmpty && cursor.utf8.count <= 4096 && cursor.utf8.allSatisfy {
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
    }
}

/// An empty page can still carry a cursor when non-business roots were filtered.
public struct MobileBusinessRoots: Sendable {
    public private(set) var roots: [MobileBusinessRoot] = []
    public private(set) var nextCursor: String?
    private var consumed: Set<String> = []
    private var loaded = false
    public init() {}
    public mutating func append(_ page: MobileBusinessRootsPage, requestedCursor: String?) throws {
        guard page.schemaVersion == 1, page.roots.count <= 20, page.roots.allSatisfy(\.isValid),
              Set(page.roots.map(\.id)).count == page.roots.count, requestedCursor == nextCursor,
              !loaded || requestedCursor != nil, validCursor(page.nextCursor),
              page.nextCursor.map({ $0 != requestedCursor && !consumed.contains($0) }) ?? true
        else { throw MobilePilotError.invalidResponse }
        if let requestedCursor { consumed.insert(requestedCursor) }
        let known = Set(roots.map(\.id)); roots += page.roots.filter { !known.contains($0.id) }
        nextCursor = page.nextCursor; loaded = true
    }
}

public struct MobileBusinessProjects: Sendable {
    public private(set) var projects: [MobileBusinessProject] = []
    public private(set) var nextCursor: String?
    private var consumed: Set<String> = []
    private var loaded = false
    public init() {}
    public mutating func append(_ page: MobileBusinessProjectsPage, requestedCursor: String?) throws {
        guard page.schemaVersion == 1, page.projects.count <= 20, page.projects.allSatisfy(\.isValid),
              Set(page.projects.map(\.id)).count == page.projects.count, requestedCursor == nextCursor,
              !loaded || requestedCursor != nil, validCursor(page.nextCursor),
              page.nextCursor.map({ $0 != requestedCursor && !consumed.contains($0) }) ?? true
        else { throw MobilePilotError.invalidResponse }
        if let requestedCursor { consumed.insert(requestedCursor) }
        let known = Set(projects.map(\.id)); projects += page.projects.filter { !known.contains($0.id) }
        nextCursor = page.nextCursor; loaded = true
    }
}
