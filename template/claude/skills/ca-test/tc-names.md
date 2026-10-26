# TC id 가 실행 결과에 찍히는 자리 — 러너별

`code-agent test` 는 실행 결과의 **테스트 이름**에서 `TC-<숫자>` 만 읽는다. 앞뒤에 영문자·숫자가 붙으면 다른 id 다 — `TC-3_empty`·`[TC-3]` 은 되고 `TC-3a`·`xTC-3` 은 안 된다. `TC_3`·`TC3`·`tc-3`·`TC 3` 은 인식되지 않는다. 주석·로그 출력·파일 안 문자열은 결과가 아니다.

| 러너 | 읽는 결과 | 이름 넣는 자리 | 결과의 이름 |
|---|---|---|---|
| node:test | TAP·spec | `test("TC-1 빈 장바구니는 0원", …)` | `✔ TC-1 빈 장바구니는 0원` |
| Jest·Vitest | JUnit 보고서(jest-junit · `--reporter=junit`) | `it("TC-2 …", …)` | `<testcase name="TC-2 …">` |
| pytest | `-v` 또는 `--junitxml` | 함수 이름엔 하이픈을 못 쓴다 — `pytest.param(…, id="TC-3")`·`ids=["TC-3"]` | `test_cart.py::test_total[TC-3] PASSED` |
| unittest | `-v` | 메서드 docstring 첫 줄 `"""TC-4 …"""` | `TC-4 … ... ok` |
| JUnit 5 (Gradle·Maven) | 보고서 XML | 메서드 이름엔 하이픈을 못 쓴다 — `@DisplayName("TC-5 …")` | 보고서 `testcase name` 에 표시 이름이 실리는지 확인한다(빌드 설정에 따라 메서드 이름만 실린다) |
| Go | `go test -json` | `t.Run("TC-6 empty cart", …)` | `TestCart/TC-6_empty_cart` |
| 그 밖 | code-agent-test JSONL | 케이스마다 한 줄 출력 | `{"type":"code-agent-test","id":"TC-7","status":"passed"}` (`failed`·`skipped`·`not-run`) |

보고서는 이번 실행에서 새로 생기거나 바뀐 `TEST-*.xml`·`junit*.xml`·`test-results.xml` 또는 `test-results/`·`surefire-reports/`·`failsafe-reports/` 아래 XML 만 읽는다. Jest verbose 의 실패 표시(`✕`)는 결과로 읽지 않으므로 보고서를 쓴다.

**전체 실행 전에 확인한다** — 러너의 수집 기능이 있으면(`pytest --collect-only -q` 등) 이름에 id 가 실리는지 본다. `code-agent check` 는 id 가 어느 테스트 파일에도 없거나 `TC_3` 같은 표기로만 있으면 알린다.

`kind: test` 단계 또는 refactor 작업은 통과 TC 토큰이 테스트 파일(refactor는 기존 테스트)에도 있어야 한다. 출력에만 있으면 미확인이다.
