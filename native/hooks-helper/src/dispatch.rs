use super::{Owner, required, emit};
use anyhow::{Result, Context, bail, ensure};
use codex_hooks::*;
use serde_json::{Value, json};
use std::path::PathBuf;

fn string(p: &Value, name: &str) -> Result<String> { Ok(required(p, name)?.to_owned()) }
fn value(p: &Value, name: &str) -> Result<Value> { p.get(name).cloned().with_context(|| format!("missing {name}")) }
fn optional_string(p: &Value, name: &str) -> Result<Option<String>> {
    p.get(name).filter(|v| !v.is_null()).map(|v| v.as_str().map(str::to_owned).with_context(|| format!("{name} must be a string"))).transpose()
}
fn subagent(p: &Value) -> Result<Option<SubagentHookContext>> {
    p.get("subagent").filter(|v| !v.is_null()).map(|s| Ok(SubagentHookContext {
        agent_id: string(s,"agentId")?, agent_type: string(s,"agentType")?,
    })).transpose()
}
fn aliases(p: &Value) -> Result<Vec<String>> {
    Ok(serde_json::from_value(p.get("matcherAliases").cloned().unwrap_or_else(|| json!([])))?)
}
pub(crate) async fn execute(owner: &Owner, hooks: &Hooks, p: Value) -> Result<Value> {
    let result = execute_inner(owner, hooks, p).await?;
    // The native receiver reports background completions only. Synchronous
    // completions are returned by each dispatcher and must also reach the UI.
    if let Some(events) = result.get("hook_events").and_then(Value::as_array) {
        for event in events {
            emit(json!({"method":"hooks/completed","params":event}));
        }
    }
    Ok(result)
}
async fn execute_inner(owner: &Owner, hooks: &Hooks, p: Value) -> Result<Value> {
    ensure!(required(&p,"threadId")? == owner.thread_id.to_string(), "hook thread ownership mismatch");
    let cwd = std::fs::canonicalize(required(&p,"cwd")?).context("hook cwd unavailable")?;
    ensure!(cwd == owner.cwd.as_path(), "hook workspace ownership mismatch");
    let event = required(&p,"event")?;
    ensure!(HOOK_EVENT_NAMES.contains(&event), "unsupported hook event");
    let turn_id = if event == "SessionStart" { optional_string(&p,"turnId")?.unwrap_or_default() } else { string(&p,"turnId")? };
    let transcript_path = optional_string(&p,"transcriptPath")?.map(PathBuf::from);
    if let Some(path) = &transcript_path { ensure!(path.is_absolute(), "transcriptPath must be executor-local and absolute"); }
    let model = if event == "SessionEnd" { String::new() } else { string(&p,"model")? };
    let permission_mode = if ["SessionEnd","PreCompact","PostCompact"].contains(&event) { String::new() } else { string(&p,"permissionMode")? };
    let subagent = subagent(&p)?;
    let request_metadata = p.get("requestMetadata").filter(|v| !v.is_null()).map(|v| v.as_object().cloned().context("requestMetadata must be an object")).transpose()?;
    macro_rules! run {
        ($request:expr, $preview:ident, $run:ident, $($field:ident),+ $(,)?) => {{
            let request = $request;
            emit(json!({"method":"hooks/started","params":{"threadId":owner.thread_id.to_string(),"turnId":turn_id,"hooks":hooks.$preview(&request)}}));
            let outcome = hooks.$run(request).await;
            Ok(json!({$(stringify!($field):outcome.$field),+}))
        }}
    }
    match event {
        "UserPromptSubmit" => run!(UserPromptSubmitRequest { session_id: owner.session_id, turn_id: turn_id.clone(), subagent, cwd: owner.cwd.clone(), transcript_path, model, permission_mode, prompt: string(&p,"prompt")? },
            preview_user_prompt_submit, run_user_prompt_submit, hook_events, should_stop, stop_reason, additional_contexts),
        "PreToolUse" => run!(PreToolUseRequest { session_id: owner.session_id, turn_id: turn_id.clone(), subagent, cwd: owner.cwd.clone(), transcript_path, model, permission_mode, tool_name: string(&p,"toolName")?,
            matcher_aliases: aliases(&p)?, tool_use_id: string(&p,"toolUseId")?, tool_input: value(&p,"toolInput")? },
            preview_pre_tool_use, run_pre_tool_use, hook_events, should_block, block_reason, additional_contexts, updated_input),
        "PostToolUse" => run!(PostToolUseRequest { session_id: owner.session_id, turn_id: turn_id.clone(), subagent, cwd: owner.cwd.clone(), transcript_path, model, permission_mode, tool_name: string(&p,"toolName")?,
            matcher_aliases: aliases(&p)?, tool_use_id: string(&p,"toolUseId")?, tool_input: value(&p,"toolInput")?, tool_response: value(&p,"toolResponse")? },
            preview_post_tool_use, run_post_tool_use, hook_events, should_block, additional_contexts, feedback_message),
        "PreCompact" => run!(PreCompactRequest { session_id: owner.session_id, turn_id: turn_id.clone(), subagent, cwd: owner.cwd.clone(), transcript_path, model, trigger: string(&p,"trigger")? },
            preview_pre_compact, run_pre_compact, hook_events, should_stop, stop_reason),
        "PostCompact" => run!(PostCompactRequest { session_id: owner.session_id, turn_id: turn_id.clone(), subagent, cwd: owner.cwd.clone(), transcript_path, model, trigger: string(&p,"trigger")? },
            preview_post_compact, run_post_compact, hook_events, should_stop, stop_reason),
        "PermissionRequest" => {
            let request = PermissionRequestRequest { session_id: owner.session_id, turn_id: turn_id.clone(), subagent,
                cwd: cwd.clone(), transcript_path, model, permission_mode, tool_name: string(&p,"toolName")?,
                matcher_aliases: aliases(&p)?, run_id_suffix: string(&p,"toolUseId")?, tool_input: value(&p,"toolInput")? };
            emit(json!({"method":"hooks/started","params":{"threadId":owner.thread_id.to_string(),"turnId":turn_id,"hooks":hooks.preview_permission_request(&request)}}));
            let o = hooks.run_permission_request(request).await;
            let decision = o.decision.map(|d| match d {
                PermissionRequestDecision::Allow => json!({"behavior":"allow"}),
                PermissionRequestDecision::Deny { message } => json!({"behavior":"deny","message":message}),
            });
            Ok(json!({"hook_events":o.hook_events,"decision":decision}))
        }
        "SessionStart" | "SubagentStart" => {
            let target = if event == "SubagentStart" { StartHookTarget::SubagentStart {
                turn_id: turn_id.clone(), agent_id: string(&p,"agentId")?, agent_type: string(&p,"agentType")?,
            }} else { StartHookTarget::SessionStart { source: match required(&p,"source")? {
                "startup" => SessionStartSource::Startup, "resume" => SessionStartSource::Resume,
                "clear" => SessionStartSource::Clear, "compact" => SessionStartSource::Compact,
                "fork" => SessionStartSource::Fork, _ => bail!("invalid SessionStart source"),
            }}};
            let request = SessionStartRequest { session_id: owner.session_id, cwd: owner.cwd.clone(), transcript_path, model, permission_mode, target };
            emit(json!({"method":"hooks/started","params":{"threadId":owner.thread_id.to_string(),"turnId":turn_id,"hooks":hooks.preview_session_start(&request)}}));
            let o = hooks.run_session_start(request, (!turn_id.is_empty()).then_some(turn_id)).await;
            Ok(json!({"hook_events":o.hook_events,"should_stop":o.should_stop,"stop_reason":o.stop_reason,"additional_contexts":o.additional_contexts}))
        }
        "Stop" | "SubagentStop" => {
            let target = if event == "SubagentStop" { StopHookTarget::SubagentStop {
                agent_id: string(&p,"agentId")?, agent_type: string(&p,"agentType")?,
                agent_transcript_path: optional_string(&p,"agentTranscriptPath")?.map(PathBuf::from),
            }} else if p.get("memoryConsolidation").and_then(Value::as_bool).unwrap_or(false) { StopHookTarget::MemoryConsolidation }
            else { StopHookTarget::Stop };
            run!(StopRequest { session_id: owner.session_id, turn_id: turn_id.clone(), cwd: owner.cwd.clone(), transcript_path,
                model, permission_mode, request_metadata, stop_hook_active: p.get("stopHookActive").and_then(Value::as_bool).context("missing stopHookActive")?,
                last_assistant_message: optional_string(&p,"lastAssistantMessage")?, target },
                preview_stop, run_stop, hook_events, should_stop, stop_reason, should_block, block_reason, continuation_fragments)
        }
        "SessionEnd" => {
            emit(json!({"method":"hooks/started","params":{"threadId":owner.thread_id.to_string(),"turnId":turn_id,"hooks":hooks.preview_session_end()}}));
            let o = hooks.run_session_end(SessionEndRequest { session_id: owner.session_id, turn_id, cwd: owner.cwd.clone(), transcript_path }).await;
            Ok(json!({"hook_events":o.hook_events}))
        }
        "Interrupt" => {
            emit(json!({"method":"hooks/started","params":{"threadId":owner.thread_id.to_string(),"turnId":turn_id,"hooks":hooks.preview_interrupt()}}));
            let o = hooks.run_interrupt(InterruptRequest { session_id: owner.session_id, turn_id, cwd: owner.cwd.clone(), transcript_path,
                model, permission_mode, request_metadata }).await;
            Ok(json!({"hook_events":o.hook_events}))
        }
        _ => bail!("unsupported hook event"),
    }
}
