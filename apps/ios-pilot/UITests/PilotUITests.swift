import XCTest

final class PilotUITests: XCTestCase {
    @MainActor
    func testLaunchAndChecklistReset() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Ready for the field."].waitForExistence(timeout: 15))
        app.staticTexts["North field survey"].tap()
        let task = app.buttons["Confirm site access"]
        XCTAssertTrue(task.waitForExistence(timeout: 5))
        XCTAssertEqual(task.value as? String, "Incomplete")
        task.tap()
        XCTAssertEqual(task.value as? String, "Complete")
        app.tabBars.buttons["Pilot"].tap()
        app.buttons["Reset demo workspace"].tap()
        app.tabBars.buttons["Today"].tap()
        XCTAssertEqual(task.value as? String, "Incomplete")
    }

    @MainActor
    func testSearchAndStatusEmptyState() {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Operations"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("cedar")
        XCTAssertTrue(app.staticTexts["North field survey"].exists)
        XCTAssertFalse(app.staticTexts["Roof inspection"].exists)
        app.buttons["Cancel"].tap()
        let filter = app.buttons["operation-status-filter"]
        XCTAssertTrue(filter.waitForExistence(timeout: 5))
        filter.tap()
        app.buttons["Ready for delivery"].tap()
        search.tap()
        search.typeText("cedar")
        XCTAssertTrue(app.staticTexts["No operations found"].waitForExistence(timeout: 5))
    }
}
