import requests

BASE_URL = "http://127.0.0.1:36941"
TIMEOUT = 30


def test_post_v1_tools_session_id_tool_name_invoke_invokes_tool():
    session_id = None
    try:
        # Step 1: Create a new session to use for the tool invocation
        payload_create_session = {}
        resp_create_session = requests.post(f"{BASE_URL}/v1/sessions", json=payload_create_session, timeout=TIMEOUT)
        assert resp_create_session.status_code == 200, f"Failed to create session: {resp_create_session.text}"
        session_data = resp_create_session.json()
        assert "session_id" in session_data, "Response missing session_id"
        session_id = session_data["session_id"]

        # Step 2: Get the list of available tools
        resp_tools = requests.get(f"{BASE_URL}/v1/tools", timeout=TIMEOUT)
        assert resp_tools.status_code == 200, f"Failed to get tools: {resp_tools.text}"
        tools = resp_tools.json()
        assert isinstance(tools, list) and len(tools) > 0, "No tools available to invoke"

        # Select the first tool_name from the list
        tool_name = tools[0]
        if isinstance(tool_name, dict) and "name" in tool_name:
            tool_name = tool_name["name"]
        elif not isinstance(tool_name, str):
            raise AssertionError("Tool list response format not recognized")

        # Prepare a valid input payload for the tool invocation
        # Using an empty dict as a generic valid input unless specific required fields are known
        payload = {}

        # Step 3: POST to invoke the tool with the session_id and tool_name
        resp_invoke = requests.post(
            f"{BASE_URL}/v1/tools/{session_id}/{tool_name}/invoke",
            json=payload,
            timeout=TIMEOUT,
        )
        assert resp_invoke.status_code == 200, f"Tool invocation failed: {resp_invoke.text}"

        tool_result = resp_invoke.json()
        assert tool_result is not None, "Tool invocation returned no result"

    finally:
        if session_id:
            # Cleanup: Close the created session
            try:
                requests.post(f"{BASE_URL}/v1/sessions/{session_id}/close", timeout=TIMEOUT)
            except Exception:
                pass


test_post_v1_tools_session_id_tool_name_invoke_invokes_tool()
