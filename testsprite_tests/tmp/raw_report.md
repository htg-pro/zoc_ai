
# TestSprite AI Testing Report(MCP)

---

## 1️⃣ Document Metadata
- **Project Name:** Archivezip
- **Date:** 2026-06-13
- **Prepared by:** TestSprite AI Team

---

## 2️⃣ Requirement Validation Summary

#### Test TC001 Send a coding prompt and receive a streamed agent response
- **Test Code:** [TC001_Send_a_coding_prompt_and_receive_a_streamed_agent_response.py](./TC001_Send_a_coding_prompt_and_receive_a_streamed_agent_response.py)
- **Test Error:** TEST BLOCKED

The streamed assistant response could not be produced because the local agent backend is not running.

Checklist verification against the user request:
- Navigate to / : Completed — the UI is at http://localhost:1420 and the app is visible.
- Type a coding-related prompt into the agent composer: Completed — the message "Write a Python function fib(n) that returns a list of the first n Fibonacci numbers using an iterative approach, include brief inline comments, and explain the time and space complexity." is present in the conversation timeline with a timestamp.
- Send the prompt: Attempted — the Send button was clicked, but the run did not start.
- Verify the user message appears in the conversation timeline: Verified — the user message is visible.
- Verify a streamed assistant response appears and the run completes: Cannot verify — blocked by backend error. The page shows the following error message verbatim: "Error: llama-server is not running. Start llama.cpp from Settings -> Models or load a local .gguf model before sending."

Observations:
- The conversation shows the user message but no assistant streaming or tokens.
- The UI displays an explicit error indicating the agent sidecar / llama-server is not reachable, preventing the test from exercising streamed output.

Conclusion: TEST BLOCKED — the feature could not be exercised because the local llama-server/agent sidecar is not running. Start the local server or load a model (per the error guidance) and rerun the test to verify streaming behavior.

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/343eb0fd-9075-4814-aece-2973671565a3
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC002 Choose a workspace and enter the main shell
- **Test Code:** [TC002_Choose_a_workspace_and_enter_the_main_shell.py](./TC002_Choose_a_workspace_and_enter_the_main_shell.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/9b906f6e-4ce8-4a77-a83c-962ae4f8f386
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC003 Save Groq provider settings and discover models
- **Test Code:** [TC003_Save_Groq_provider_settings_and_discover_models.py](./TC003_Save_Groq_provider_settings_and_discover_models.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/73a5fbe6-c792-4e96-ba98-3ce6aeeca75b
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC004 Create a new chat session
- **Test Code:** [TC004_Create_a_new_chat_session.py](./TC004_Create_a_new_chat_session.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/edda6287-8840-402f-a5cb-2298b7b3b318
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC005 Switch to another chat session
- **Test Code:** [TC005_Switch_to_another_chat_session.py](./TC005_Switch_to_another_chat_session.py)
- **Test Error:** TEST FAILURE

Switching sessions did not update the Agent conversation panel — selecting an existing session did not load its conversation into the Agent chat area.

Observations:
- The 'groq smoke' session row is present and becomes highlighted when clicked in the Sessions list.
- The Agent panel on the right continues to display the default "Agent ready" content and no chat messages after multiple selection attempts.
- Repeated clicks (4+ tries) on the session did not cause any visible change to the conversation content in the Agent area.

Conclusion: The session-switching UI is present and selectable, but the application did not render or load the session's messages into the Agent chat panel, so the required functionality failed verification.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/0e7ca9c2-f5c8-447c-9926-165aa8634c34
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC006 Open settings and discover Groq models
- **Test Code:** [TC006_Open_settings_and_discover_Groq_models.py](./TC006_Open_settings_and_discover_Groq_models.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/edbe586c-2941-4d2b-9a94-255525fcb701
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC007 Choose a Groq model in the agent panel
- **Test Code:** [TC007_Choose_a_Groq_model_in_the_agent_panel.py](./TC007_Choose_a_Groq_model_in_the_agent_panel.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/6d7d29ce-9d87-470e-a980-45235ff27868
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC008 Delete a chat session
- **Test Code:** [TC008_Delete_a_chat_session.py](./TC008_Delete_a_chat_session.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/a25768c4-29d9-42b7-a70c-26387989f6be
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC009 Rename a chat session
- **Test Code:** [TC009_Rename_a_chat_session.py](./TC009_Rename_a_chat_session.py)
- **Test Error:** TEST FAILURE

Renaming a session from its context menu is not available.

Observations:
- The context menu for the 'groq smoke' session (opened) displays only the 'Pin' and 'Delete' controls.
- No 'Rename' or 'Edit name' option is visible in the session entry or its context controls.

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/2ebed117-bd1d-4ec1-9deb-7f52123c450b
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC010 Choose a local llama.cpp model and see its status
- **Test Code:** [TC010_Choose_a_local_llama.cpp_model_and_see_its_status.py](./TC010_Choose_a_local_llama.cpp_model_and_see_its_status.py)
- **Test Error:** TEST BLOCKED

No local llama.cpp (.gguf) model could be selected because none are registered in the UI.

Observations:
- The model picker menu is open and shows the message: "No local .gguf registered. Add one in Settings → Models." 
- The menu lists remote/provider models and prompts to configure API keys, but no local model entries are present.

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/03bcc876-75ea-4034-a2b9-5ad5df9a4d82
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC011 Switch to Ask mode and receive a direct assistant answer
- **Test Code:** [TC011_Switch_to_Ask_mode_and_receive_a_direct_assistant_answer.py](./TC011_Switch_to_Ask_mode_and_receive_a_direct_assistant_answer.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the model backend required to produce a streamed assistant response is not available.

Observations:
- The UI shows the error: "Error: llama-server is not running. Start llama.cpp from Settings -> Models or load a local .gguf model before sending." 
- The Send button is disabled and no assistant output is being produced.
- No model is selected/connected, so Ask mode cannot produce a streamed response.

- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/522242e0-666f-4032-bc0c-6287e21f3d9b
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC012 View the current session after provider configuration persists
- **Test Code:** [TC012_View_the_current_session_after_provider_configuration_persists.py](./TC012_View_the_current_session_after_provider_configuration_persists.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/3e7b71bc-1746-4f19-95d6-3a1b94dc78ef
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC013 Stop a long-running agent response
- **Test Code:** [TC013_Stop_a_long_running_agent_response.py](./TC013_Stop_a_long_running_agent_response.py)
- **Test Error:** TEST BLOCKED

The test could not be run — the local model server required to start agent runs is not running.

Observations:
- The UI shows the error: 'Error: llama-server is not running. Start llama.cpp from Settings -> Models or load a local .gguf model before sending.'
- The 'Send' button in the composer is disabled and no streaming response started.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/e37b79e4-7a9a-472c-9b52-f53a99f522e7
- **Status:** BLOCKED
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC014 Configure a local llama.cpp model and continue chatting
- **Test Code:** [TC014_Configure_a_local_llama.cpp_model_and_continue_chatting.py](./TC014_Configure_a_local_llama.cpp_model_and_continue_chatting.py)
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/73dd139a-fef1-442d-8349-c2c0b37dcf81
- **Status:** ✅ Passed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---

#### Test TC015 Reject an invalid Groq key without enabling models
- **Test Code:** [TC015_Reject_an_invalid_Groq_key_without_enabling_models.py](./TC015_Reject_an_invalid_Groq_key_without_enabling_models.py)
- **Test Error:** TEST FAILURE

Entering the provided Groq API key resulted in a usable model list and a 'configured' provider state, so an invalid key was accepted and produced models instead of showing a validation or warning state.

Observations:
- The Groq provider card is marked "configured" and shows a live models list (16 models) after fetching models.
- The Models field contains concrete model names (for example: allam-2-7b, canopylabs/orpheus-...), indicating models were loaded into the chat model picker.
- No explicit validation or warning messages such as "Mock response" or "agent sidecar not reachable" were visible on the Providers page.
- **Test Visualization and Result:** https://www.testsprite.com/dashboard/mcp/tests/6cc67335-9a31-4077-8e26-9dca916d61a4/4696b056-0cc5-4b26-ae05-6855c3748925
- **Status:** ❌ Failed
- **Analysis / Findings:** {{TODO:AI_ANALYSIS}}.
---


## 3️⃣ Coverage & Matching Metrics

- **53.33** of tests passed

| Requirement        | Total Tests | ✅ Passed | ❌ Failed  |
|--------------------|-------------|-----------|------------|
| ...                | ...         | ...       | ...        |
---


## 4️⃣ Key Gaps / Risks
{AI_GNERATED_KET_GAPS_AND_RISKS}
---