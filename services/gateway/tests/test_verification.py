from zocai_gateway.verification import parse_verify_result


def test_parse_pytest_failures() -> None:
    result = parse_verify_result(
        "pytest",
        "FAILED tests/test_api.py::test_create - AssertionError\n1 failed, 2 passed",
        1,
    )
    assert result.failures == [
        "tests/test_api.py::test_create - AssertionError"
    ]


def test_parse_jest_failures() -> None:
    result = parse_verify_result(
        "npm test", "FAIL src/app.test.ts\n  ● app › renders", 1
    )
    assert result.failures == ["app › renders", "src/app.test.ts"]


def test_parse_cargo_and_go_failures() -> None:
    cargo = parse_verify_result(
        "cargo test", "test parser::rejects_invalid ... FAILED", 101
    )
    go = parse_verify_result("go test ./...", "--- FAIL: TestCreate (0.01s)", 1)
    assert cargo.failures == ["parser::rejects_invalid"]
    assert go.failures == ["TestCreate"]


def test_success_preserves_output_without_failures() -> None:
    result = parse_verify_result("pytest", "4 passed", 0)
    assert result.passed is True
    assert result.failures == []
    assert result.output == "4 passed"
